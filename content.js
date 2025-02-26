(function () {
    // Prevent duplicate injection
    if (window.autoScrollInjected) {
        console.log("AutoScroll content script already injected.");
        return;
    }
    window.autoScrollInjected = true;

    const debug = true;

    function dlog(...args) {
        if (!debug) return;
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const ss = String(now.getSeconds()).padStart(2, "0");
        const ms = String(now.getMilliseconds()).padStart(3, "0");
        console.log(`[${hh}:${mm}:${ss}.${ms}]`, ...args);
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    let userPluginEnabled = false;   // Tracks the extension toggle from background
    let autoScrollEnabled = false;   // Script's internal on/off
    let userScrolled = false;
    let currentVideo = null;
    let globalObserver = null;

    let pollIntervalId = null;
    let lastKnownPaused = false;
    let videoTimeout = null;
    let remainingTime = 0;
    let videoStartTime = 0;
    let maxDuration = 60000;
    const BUFFER_EXTRA_MS = 2000;
    let reelStartTime = 0;

    // ============================================
    // Listen for messages from background
    // ============================================
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === "setAutoScroll") {
            userPluginEnabled = msg.enabled;  // The user toggled from the extension icon
            dlog(`User plugin enabled: ${userPluginEnabled}`);

            // Force a platform check immediately (so we don't wait for the next interval)
            checkPlatform();
        }
    });

    // ============================================
    // Periodic check: Are we on Reels/Shorts?
    // ============================================
    // We do this so that if user navigates away, we disable auto‐scroll;
    // if user returns, we enable it (only if userPluginEnabled is true).
    setInterval(checkPlatform, 1000);

    function checkPlatform() {
        if (!userPluginEnabled) {
            // If user explicitly toggled plugin OFF, ensure autoScroll is off
            if (autoScrollEnabled) {
                setAutoScroll(false);
            }
            return;
        }

        // If user toggled plugin ON, check if we're on a known Reels/Shorts path
        const url = window.location.href;
        const isReelsShorts =
            url.includes("facebook.com/reel") ||
            url.includes("youtube.com/shorts") ||
            url.includes("instagram.com/reels") ||
            url.includes("tiktok.com");

        if (isReelsShorts) {
            // If not yet enabled, enable it
            if (!autoScrollEnabled) {
                setAutoScroll(true);
            }
        } else {
            // If we've navigated away from Reels, disable
            if (autoScrollEnabled) {
                setAutoScroll(false);
            }
        }
    }

    // ============================================
    // Toggle the script's internal autoScroll
    // ============================================
    function setAutoScroll(enabled) {
        autoScrollEnabled = enabled;
        dlog(`AutoScroll set to: ${autoScrollEnabled}`);

        if (autoScrollEnabled) {
            startObservingVideos();
            const video = document.querySelector("video");
            if (video && video !== currentVideo) {
                untrackCurrentVideo();
                currentVideo = video;
                trackVideoEvents(video);
                resetManualScroll();
                initVideoDuration(video);
            }
        } else {
            stopObservingVideos();
            untrackCurrentVideo();
            dlog("AutoScroll disabled, cleaned up.");
        }
    }

    // ============================================
    // Mutation Observer
    // ============================================
    function startObservingVideos() {
        if (globalObserver) return;

        globalObserver = new MutationObserver(() => {
            if (!autoScrollEnabled) return;
            const video = document.querySelector("video");
            if (video && video !== currentVideo) {
                dlog("New video detected!");
                untrackCurrentVideo();
                currentVideo = video;
                trackVideoEvents(video);
                resetManualScroll();
                initVideoDuration(video);
            }
        });

        globalObserver.observe(document.body, { childList: true, subtree: true });
    }

    function stopObservingVideos() {
        if (globalObserver) {
            globalObserver.disconnect();
            globalObserver = null;
        }
    }

    // ============================================
    // Video Events
    // ============================================
    function trackVideoEvents(video) {
        dlog("Tracking video events...");
        startPausePolling(video);
        video.addEventListener("ended", onVideoEnded);

        document.addEventListener("scroll", onUserScroll, { passive: true });
        document.addEventListener("visibilitychange", onVisibilityChange);
    }

    function untrackCurrentVideo() {
        if (currentVideo) {
            dlog("Untracking old video...");
            stopPausePolling();
            currentVideo.removeEventListener("ended", onVideoEnded);
            currentVideo = null;
        }
        clearTimeout(videoTimeout);

        document.removeEventListener("scroll", onUserScroll);
        document.removeEventListener("visibilitychange", onVisibilityChange);
    }

    // ============================================
    // Polling for play/pause
    // ============================================
    function startPausePolling(video) {
        if (pollIntervalId) return;

        pollIntervalId = setInterval(() => {
            if (!video) return;
            const actuallyPaused = video.paused || video.readyState < 2;
            if (actuallyPaused && !lastKnownPaused) {
                lastKnownPaused = true;
                onVideoPause();
            } else if (!actuallyPaused && lastKnownPaused) {
                lastKnownPaused = false;
                onVideoPlay();
            }
        }, 500);
    }

    function stopPausePolling() {
        if (pollIntervalId) {
            clearInterval(pollIntervalId);
            pollIntervalId = null;
            lastKnownPaused = false;
        }
    }

    // ============================================
    // Video Duration
    // ============================================
    function initVideoDuration(video) {
        reelStartTime = Date.now();

        if (video.readyState >= 1) {
            setupMaxDuration(video);
        } else {
            video.addEventListener("loadedmetadata", function onMetaLoaded() {
                video.removeEventListener("loadedmetadata", onMetaLoaded);
                setupMaxDuration(video);
            });
        }
    }

    function setupMaxDuration(video) {
        let durationMs = 0;

        if (video.duration && isFinite(video.duration) && video.duration > 0) {
            durationMs = (video.duration * 1000) + BUFFER_EXTRA_MS;
            dlog(`Video reported duration: ${video.duration.toFixed(2)}s, using ${durationMs.toFixed(0)}ms + buffer.`);
        } else {
            durationMs = 60000;
            dlog(`Could not determine video duration. Using fallback: ${durationMs}ms`);
        }

        maxDuration = durationMs;
        startVideoTimeout();
    }

    // ============================================
    // Timeout / Countdown
    // ============================================
    function startVideoTimeout() {
        clearTimeout(videoTimeout);

        remainingTime = maxDuration;
        videoStartTime = Date.now();

        videoTimeout = setTimeout(() => {
            if (autoScrollEnabled && !userScrolled) {
                dlog(`Timeout of ${maxDuration.toFixed(0)}ms reached. Scrolling to next...`);
                scrollToNext();
            }
        }, remainingTime);
    }

    function pauseCountdown() {
        const elapsed = Date.now() - videoStartTime;
        remainingTime -= elapsed;
        if (remainingTime < 0) remainingTime = 0;

        dlog(`Paused countdown with ${remainingTime.toFixed(0)}ms left.`);
        clearTimeout(videoTimeout);
    }

    function resumeCountdown() {
        clearTimeout(videoTimeout);
        if (!currentVideo || userScrolled) return;

        if (remainingTime <= 0) {
            dlog("No time left; skipping now...");
            scrollToNext();
            return;
        }

        videoStartTime = Date.now();
        dlog(`Resuming countdown for ${remainingTime.toFixed(0)}ms...`);

        videoTimeout = setTimeout(() => {
            if (autoScrollEnabled && !userScrolled) {
                dlog("Remaining time expired, next video...");
                scrollToNext();
            }
        }, remainingTime);
    }

    // ============================================
    // Event Handlers
    // ============================================
    function onUserScroll() {
        dlog("User manually scrolled. Auto-scroll skipped for this video.");
        userScrolled = true;
    }

    function resetManualScroll() {
        dlog("Resetting manual scroll flag for new video.");
        userScrolled = false;
    }

    function onVisibilityChange() {
        if (!autoScrollEnabled || !currentVideo) return;
        if (document.hidden) {
            pauseCountdown();
        } else {
            resumeCountdown();
        }
    }

    function onVideoPause() {
        if (!autoScrollEnabled) return;
        dlog("Video paused, pausing countdown.");
        pauseCountdown();
    }

    function onVideoPlay() {
        if (!autoScrollEnabled) return;
        dlog("Video is playing again, resuming countdown.");
        resumeCountdown();
    }

    function onVideoEnded() {
        if (!autoScrollEnabled) return;
        dlog("Video ended, skipping to next...");
        scrollToNext();
    }

    // ============================================
    // Scroll Logic (platform-specific)
    // ============================================
    function scrollToNext() {
        if (!autoScrollEnabled) return;
        dlog("Skipping to next video...");

        const url = window.location.href;

        if (url.includes("facebook.com/reel")) {
            // Facebook approach
            const nextReelButton = document.querySelector('div[aria-label="Next Card"][role="button"]');
            if (nextReelButton) {
                dlog("Clicking Next button on Facebook Reels...");
                nextReelButton.click();
            } else {
                dlog("No next button, using ArrowRight...");
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
            }
        }

        else if (url.includes("instagram.com/reels")) {
            dlog("Instagram Reels detected!");
            dlog("attempting to scroll to the next reel...");
            scrollToNextInstagramReel();
        }

        else if (url.includes("youtube.com/shorts")) {
            dlog("YouTube Shorts - ArrowDown...");
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        }

        else if (url.includes("tiktok.com")) {
            dlog("TikTok - ArrowDown...");
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        }

        else {
            // Fallback for unknown platforms
            dlog("Unknown platform, sending ArrowDown key...");
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        }
    }

    // ============================================
    // Helper: Scroll to the next Instagram Reel
    // ============================================
    function scrollToNextInstagramReel() {
        const videos = document.querySelectorAll('video');

        if (videos.length > 1) {
            dlog(`Found ${videos.length} videos, scrolling to the next one...`);
            videos[1].scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
            dlog("Only one or no videos found. Trying to scroll the Instagram Reels feed container...");
            scrollInstagramFeed();
        }
    }




})();
