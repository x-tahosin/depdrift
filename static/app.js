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

        const map = {
            statTotal:    stats.total_deps,
            statOutdated: stats.outdated,
            statCritical: stats.critical,
            statSaved:    stats.time_saved_minutes,
        };

        for (const [id, val] of Object.entries(map)) {
            const card = document.getElementById(id);
            const numEl = card.querySelector(".stat-card__number");
            animateCounter(numEl, val);
        }
    }

    // ── Result rendering ─────────────────────────────────────────

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

            // sort: critical first, then breaking, then unknown, then safe, then current/skip
            const order = { CRITICAL: 0, BREAKING: 1, UNKNOWN: 2, SAFE: 3, SKIP: 4, CURRENT: 5 };
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
                logSection.hidden = true;
                if (data.stats) updateStats(data.stats);
                if (data.results) renderResults(data.results);
                footer.hidden = false;
                setLoading(false);
                break;

            case "error":
                showError(data.message || "Unknown error.");
                setLoading(false);
                break;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────

    function setLoading(on) {
        btn.disabled = on;
        input.disabled = on;
        btnText.hidden = on;
        btnLoading.hidden = !on;
    }

    function showError(msg) {
        logSection.hidden = true;
        var div = document.createElement("div");
        div.className = "error-msg";
        div.textContent = msg;
        resultsContainer.innerHTML = "";
        resultsContainer.appendChild(div);
        resultsSection.hidden = false;
    }

    function escHtml(str) {
        var div = document.createElement("div");
        div.appendChild(document.createTextNode(str || ""));
        return div.innerHTML;
    }

    // ── Form submit ──────────────────────────────────────────────

    form.addEventListener("submit", function (e) {
        e.preventDefault();
        var val = input.value.trim();
        if (!val) return;
        startScan(val);
    });
})();
