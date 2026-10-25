/**
 * DepDrift — Frontend logic
 *
 * Handles scan form submission, SSE event parsing,
 * live log updates, stat counter animations, and result rendering.
 */

(function () {
    "use strict";

    // ── DOM refs ──────────────────────────────────────────────────

    const form        = document.getElementById("scanForm");
    const input       = document.getElementById("scanInput");
    const btn         = document.getElementById("scanBtn");
    const btnText     = btn.querySelector(".scan-form__btn-text");
    const btnLoading  = btn.querySelector(".scan-form__btn-loading");
    const logSection  = document.getElementById("logSection");
    const logText     = document.getElementById("logText");
    const statsSection = document.getElementById("statsSection");
    const resultsSection = document.getElementById("resultsSection");
    const resultsContainer = document.getElementById("resultsContainer");
    const footer      = document.getElementById("footer");

    // ── Particle background ──────────────────────────────────────

    (function initParticles() {
        const canvas = document.getElementById("particles");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        let w, h;
        const particles = [];
        const COUNT = 60;

        function resize() {
            w = canvas.width = window.innerWidth;
            h = canvas.height = window.innerHeight;
        }
        resize();
        window.addEventListener("resize", resize);

        for (let i = 0; i < COUNT; i++) {
            particles.push({
                x: Math.random() * w,
                y: Math.random() * h,
                r: Math.random() * 1.5 + 0.5,
                dx: (Math.random() - 0.5) * 0.3,
                dy: (Math.random() - 0.5) * 0.3,
                a: Math.random() * 0.4 + 0.1,
            });
        }

        function draw() {
            ctx.clearRect(0, 0, w, h);
            for (const p of particles) {
                p.x += p.dx;
                p.y += p.dy;
                if (p.x < 0) p.x = w;
                if (p.x > w) p.x = 0;
                if (p.y < 0) p.y = h;
                if (p.y > h) p.y = 0;

                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(0, 201, 219, ${p.a})`;
                ctx.fill();
            }
            requestAnimationFrame(draw);
        }
        draw();
    })();

    // ── Quick-fill buttons ───────────────────────────────────────

    document.querySelectorAll(".link-btn[data-fill]").forEach(function (el) {
        el.addEventListener("click", function () {
            input.value = el.dataset.fill;
            input.focus();
        });
    });

    // ── Counter animation ────────────────────────────────────────

    function animateCounter(el, target) {
        if (!el) return;
        const duration = 800;
        const start = performance.now();
        const from = parseInt(el.textContent, 10) || 0;
        const diff = target - from;

        function step(now) {
            const t = Math.min((now - start) / duration, 1);
            const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
            el.textContent = Math.round(from + diff * ease);
            if (t < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    function updateStats(stats) {
        statsSection.hidden = false;
        animateCounter(document.querySelector("#statTotal .stat-card__number"), stats.total_deps || 0);
        animateCounter(document.querySelector("#statOutdated .stat-card__number"), stats.outdated || 0);
        animateCounter(document.querySelector("#statCritical .stat-card__number"), stats.critical || 0);
        animateCounter(document.querySelector("#statBrowserbase .stat-card__number"), stats.browserbase_extractions || 0);
        animateCounter(document.querySelector("#statSaved .stat-card__number"), stats.time_saved_minutes || 0);
    }

    // ── UI state helpers ─────────────────────────────────────────

    function setLoading(loading) {
        btn.disabled = loading;
        btnText.hidden = loading;
        btnLoading.hidden = !loading;
    }

    function showError(msg) {
        logSection.hidden = false;
        logText.innerHTML = '<span style="color:var(--color-critical)">' + escHtml(msg) + "</span>";
    }

    function escHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // ── Render results ───────────────────────────────────────────

    function renderResults(results) {
        resultsSection.hidden = false;
        resultsContainer.innerHTML = "";

        for (const repo of results) {
            const group = document.createElement("div");
            group.className = "repo-group";

            // header
            const header = document.createElement("div");
            header.className = "repo-group__header";
            header.innerHTML =
                '<span class="repo-group__name">' +
                    '<a href="' + escHtml(repo.repo_url) + '" target="_blank" rel="noopener">' +
                        escHtml(repo.repo_name) +
                    "</a>" +
                "</span>" +
                '<span class="repo-group__stats">' +
                    repo.total + " deps · " +
                    repo.outdated + " outdated · " +
                    repo.critical + " critical" +
                "</span>";
            group.appendChild(header);

            // sort: critical first, then breaking, then safe, then skip, then current
            const order = { CRITICAL: 0, BREAKING: 1, SAFE: 2, SKIP: 3, CURRENT: 4, UNKNOWN: 5 };
            const sorted = [...repo.dependencies].sort(function (a, b) {
                return (order[a.risk] ?? 9) - (order[b.risk] ?? 9);
            });

            for (const dep of sorted) {
                const card = document.createElement("div");
                card.className = "dep-card";
                card.style.animationDelay = (sorted.indexOf(dep) * 0.04) + "s";

                let html =
                    '<div class="dep-card__name">' + escHtml(dep.name) + "</div>" +
                    '<span class="dep-card__badge badge--' + dep.risk + '">' + dep.risk + "</span>";

                if (dep.is_outdated) {
                    html +=
                        '<div class="dep-card__version">' +
                            '<code>' + escHtml(dep.current_version) + '</code>' +
                            '<span class="arrow"> → </span>' +
                            '<code class="latest">' + escHtml(dep.latest_version) + '</code>' +
                        "</div>";
                } else {
                    html +=
                        '<div class="dep-card__version">' +
                            '<code>' + escHtml(dep.current_version) + '</code>' +
                        "</div>";
                }

                if (dep.changelog_source === "browserbase" || dep.browserbase_session) {
                    const sid = dep.browserbase_session ? dep.browserbase_session.slice(0, 8) : "cloud";
                    html +=
                        '<div class="dep-card__bb-tag">' +
                            '<span class="bb-pill">🌐 Browserbase Extracted</span>' +
                            '<span class="bb-session">Session: ' + escHtml(sid) + '…</span>' +
                        '</div>';
                }

                if (dep.summary && dep.risk !== "CURRENT") {
                    html += '<div class="dep-card__summary">' + escHtml(dep.summary) + "</div>";
                }
                if (dep.action && dep.risk !== "CURRENT") {
                    html += '<div class="dep-card__action">' + escHtml(dep.action) + "</div>";
                }
                if (dep.changelog_url) {
                    html +=
                        '<a class="dep-card__link" href="' + escHtml(dep.changelog_url) +
                        '" target="_blank" rel="noopener">View changelog →</a>';
                }

                card.innerHTML = html;
                group.appendChild(card);
            }

            resultsContainer.appendChild(group);
        }
    }

    // ── SSE Scan ─────────────────────────────────────────────────

    function startScan(query) {
        // reset UI
        setLoading(true);
        logSection.hidden = false;
        logText.textContent = "Starting scan…";
        statsSection.hidden = true;
        resultsSection.hidden = true;
        resultsContainer.innerHTML = "";
        footer.hidden = true;

        const url = "/api/scan?input=" + encodeURIComponent(query);

        fetch(url).then(function (response) {
            if (!response.ok) {
                throw new Error("Server returned " + response.status);
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            function read() {
                reader.read().then(function (result) {
                    if (result.done) {
                        setLoading(false);
                        return;
                    }

                    buffer += decoder.decode(result.value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop(); // keep incomplete line

                    for (const line of lines) {
                        if (line.startsWith("data: ")) {
                            try {
                                var data = JSON.parse(line.slice(6));
                                handleEvent(data);
                            } catch (e) {
                                // skip parse errors
                            }
                        }
                    }

                    read();
                }).catch(function (err) {
                    showError("Stream error: " + err.message);
                    setLoading(false);
                });
            }
            read();
        }).catch(function (err) {
            showError("Connection failed: " + err.message);
            setLoading(false);
        });
    }

    function handleEvent(data) {
        switch (data.status) {
            case "scanning":
            case "checking":
            case "analyzing":
                logText.textContent = data.message || "Working…";
                break;

            case "repo_done":
                logText.textContent = data.message || "Repo done.";
                break;

            case "complete":
                logText.textContent = data.message || "Scan finished.";
                if (data.stats) updateStats(data.stats);
                if (data.results) renderResults(data.results);
                footer.hidden = false;
                break;

            case "error":
                showError(data.message || "An error occurred.");
                break;
        }
    }

    // ── Form submit ──────────────────────────────────────────────

    form.addEventListener("submit", function (e) {
        e.preventDefault();
        const query = input.value.trim();
        if (!query) return;
        startScan(query);
    });

})();
