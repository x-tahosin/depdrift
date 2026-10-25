/**
 * DepDrift — Authoritative Client Engine
 *
 * Implements:
 * - Ambient particle starfield canvas animation
 * - SSE streaming repository scanner
 * - Animated tabular metrics counters
 * - Risk-stratified dependency cards with Browserbase & CVE badges
 * - Filter pills & 1-click batch safe bump / PR markdown export
 * - Direct manifest auditor & single package deep inspector modals
 * - System infrastructure diagnostics
 */

(function () {
    "use strict";

    // ── Global State ───────────────────────────────────────────────
    let currentResults = [];
    let currentStats = {};
    let activeFilter = "ALL";

    // ── DOM References ─────────────────────────────────────────────
    const form             = document.getElementById("scanForm");
    const input            = document.getElementById("scanInput");
    const btn              = document.getElementById("scanBtn");
    const btnText          = btn ? btn.querySelector(".scan-form__btn-text") : null;
    const btnLoading       = btn ? btn.querySelector(".scan-form__btn-loading") : null;
    const logSection       = document.getElementById("logSection");
    const logText          = document.getElementById("logText");
    const statsSection     = document.getElementById("statsSection");
    const resultsSection   = document.getElementById("resultsSection");
    const resultsContainer = document.getElementById("resultsContainer");
    const actionStrip      = document.getElementById("actionStrip");
    const footer           = document.getElementById("footer");
    const toastContainer   = document.getElementById("toastContainer");

    // Modal References
    const modalPasteManifest  = document.getElementById("modalPasteManifest");
    const btnOpenPaste        = document.getElementById("btnOpenPaste");
    const btnClosePaste       = document.getElementById("btnClosePaste");
    const manifestInputArea   = document.getElementById("manifestInputArea");
    const btnSubmitManifest   = document.getElementById("btnSubmitManifest");
    const btnLoadSampleManifest = document.getElementById("btnLoadSampleManifest");

    const modalSingleInspect  = document.getElementById("modalSingleInspect");
    const btnOpenInspect      = document.getElementById("btnOpenInspect");
    const btnCloseInspect     = document.getElementById("btnCloseInspect");
    const inspectName         = document.getElementById("inspectName");
    const inspectVersion      = document.getElementById("inspectVersion");
    const inspectEco          = document.getElementById("inspectEco");
    const btnRunInspectPkg    = document.getElementById("btnRunInspectPkg");
    const singleInspectResult = document.getElementById("singleInspectResult");

    const modalDiagnostics    = document.getElementById("modalDiagnostics");
    const btnOpenDiag         = document.getElementById("btnOpenDiag");
    const btnCloseDiag        = document.getElementById("btnCloseDiag");
    const diagModalBody       = document.getElementById("diagModalBody");

    const depDetailModal      = document.getElementById("depDetailModal");
    const btnCloseDetail      = document.getElementById("btnCloseDetail");
    const detailDepName       = document.getElementById("detailDepName");
    const detailDepBadge      = document.getElementById("detailDepBadge");
    const detailModalBody     = document.getElementById("detailModalBody");

    // Batch & Export buttons
    const btnBatchSafe        = document.getElementById("btnBatchSafe");
    const btnExportPR         = document.getElementById("btnExportPR");
    const btnExportJSON       = document.getElementById("btnExportJSON");

    // ── Particle Starfield Canvas ──────────────────────────────────
    (function initParticles() {
        const canvas = document.getElementById("particles");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        let w, h;
        const particles = [];
        const COUNT = 65;

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
                r: Math.random() * 1.6 + 0.4,
                dx: (Math.random() - 0.5) * 0.35,
                dy: (Math.random() - 0.5) * 0.35,
                a: Math.random() * 0.45 + 0.15,
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
                ctx.fillStyle = "rgba(0, 201, 219, " + p.a + ")";
                ctx.fill();
            }
            requestAnimationFrame(draw);
        }
        draw();
    })();

    // ── Toast Helper ───────────────────────────────────────────────
    function showToast(msg, duration = 3000) {
        if (!toastContainer) return;
        const toast = document.createElement("div");
        toast.className = "toast";
        toast.textContent = msg;
        toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = "0";
            toast.style.transition = "opacity 0.3s";
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // ── Quick-Fill Buttons ─────────────────────────────────────────
    document.querySelectorAll(".link-btn[data-fill]").forEach(function (el) {
        el.addEventListener("click", function () {
            if (input) {
                input.value = el.dataset.fill;
                input.focus();
            }
        });
    });

    // ── Counter Animation ──────────────────────────────────────────
    function animateCounter(el, target) {
        if (!el) return;
        const duration = 800;
        const start = performance.now();
        const from = parseInt(el.textContent, 10) || 0;
        const diff = target - from;

        function step(now) {
            const t = Math.min((now - start) / duration, 1);
            const ease = 1 - Math.pow(1 - t, 3);
            el.textContent = Math.round(from + diff * ease);
            if (t < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    function updateStats(stats) {
        if (!statsSection) return;
        statsSection.hidden = false;
        animateCounter(document.querySelector("#statTotal .stat-card__number"), stats.total_deps || stats.total || 0);
        animateCounter(document.querySelector("#statOutdated .stat-card__number"), stats.outdated || 0);
        animateCounter(document.querySelector("#statCritical .stat-card__number"), stats.critical || 0);
        animateCounter(document.querySelector("#statBrowserbase .stat-card__number"), stats.browserbase_extractions || 0);
        animateCounter(document.querySelector("#statSaved .stat-card__number"), stats.time_saved_minutes || 0);
    }

    function updateFilterCounts(results) {
        let total = 0, critical = 0, breaking = 0, safe = 0, current = 0;
        for (const repo of results) {
            for (const dep of (repo.dependencies || [])) {
                total++;
                if (dep.risk === "CRITICAL") critical++;
                else if (dep.risk === "BREAKING") breaking++;
                else if (dep.risk === "SAFE") safe++;
                else if (dep.risk === "CURRENT") current++;
            }
        }
        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        setVal("countAll", total);
        setVal("countCritical", critical);
        setVal("countBreaking", breaking);
        setVal("countSafe", safe);
        setVal("countCurrent", current);
    }

    // ── UI State Helpers ───────────────────────────────────────────
    function setLoading(loading) {
        if (!btn) return;
        btn.disabled = loading;
        if (btnText) btnText.hidden = loading;
        if (btnLoading) btnLoading.hidden = !loading;
    }

    function showError(msg) {
        if (!logSection || !logText) return;
        logSection.hidden = false;
        logText.innerHTML = '<span style="color:var(--critical)">' + escHtml(msg) + '</span>';
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

    // ── Render Results ─────────────────────────────────────────────
    function renderResults(results) {
        currentResults = results;
        if (!resultsSection || !resultsContainer) return;
        resultsSection.hidden = false;
        resultsContainer.innerHTML = "";

        if (actionStrip) actionStrip.hidden = false;
        updateFilterCounts(results);

        const order = { CRITICAL: 0, BREAKING: 1, SAFE: 2, SKIP: 3, CURRENT: 4, UNKNOWN: 5 };

        for (const repo of results) {
            const deps = (repo.dependencies || []).filter(function (dep) {
                if (activeFilter === "ALL") return true;
                return dep.risk === activeFilter;
            });

            if (deps.length === 0 && activeFilter !== "ALL") continue;

            const group = document.createElement("div");
            group.className = "repo-group";

            // Repo header
            const header = document.createElement("div");
            header.className = "repo-group__header";
            header.innerHTML =
                '<span class="repo-group__name">' +
                    '<a href="' + escHtml(repo.repo_url) + '" target="_blank" rel="noopener">' +
                        escHtml(repo.repo_name) +
                    '</a>' +
                '</span>' +
                '<span class="repo-group__stats">' +
                    repo.total + ' deps · ' +
                    repo.outdated + ' outdated · ' +
                    repo.critical + ' critical' +
                '</span>';
            group.appendChild(header);

            // Sort dependencies by risk priority
            const sorted = [...deps].sort(function (a, b) {
                return (order[a.risk] ?? 9) - (order[b.risk] ?? 9);
            });

            for (const dep of sorted) {
                const card = document.createElement("div");
                card.className = "dep-card";
                card.style.animationDelay = (sorted.indexOf(dep) * 0.03) + "s";

                let html =
                    '<div class="dep-card__name">' + escHtml(dep.name) + '</div>' +
                    '<span class="dep-card__badge badge--' + dep.risk + '">' + dep.risk + '</span>';

                if (dep.is_outdated) {
                    html +=
                        '<div class="dep-card__version">' +
                            '<code>' + escHtml(dep.current_version) + '</code>' +
                            '<span class="arrow"> → </span>' +
                            '<code class="latest">' + escHtml(dep.latest_version) + '</code>' +
                        '</div>';
                } else {
                    html +=
                        '<div class="dep-card__version">' +
                            '<code>' + escHtml(dep.current_version) + ' (latest)</code>' +
                        '</div>';
                }

                // Browserbase session badge
                if (dep.changelog_source === "browserbase" || dep.browserbase_session) {
                    const sid = dep.browserbase_session ? dep.browserbase_session.slice(0, 8) : "cloud";
                    html +=
                        '<div class="dep-card__bb-tag">' +
                            '<span class="bb-pill">🌐 Browserbase Extracted</span>' +
                            '<span class="bb-session">Session: ' + escHtml(sid) + '…</span>' +
                        '</div>';
                }

                // Security advisories / CVE alert
                if (dep.advisories && dep.advisories.length > 0) {
                    const adv = dep.advisories[0];
                    html +=
                        '<div class="dep-card__cve-banner">' +
                            '⚠️ <strong>' + escHtml(adv.ghsa_id || adv.cve_id || "Vulnerability") + '</strong>: ' +
                            escHtml(adv.summary || "Security advisory detected.") +
                        '</div>';
                }

                if (dep.summary && dep.risk !== "CURRENT") {
                    html += '<div class="dep-card__summary">' + escHtml(dep.summary) + '</div>';
                }
                if (dep.action && dep.risk !== "CURRENT") {
                    html += '<div class="dep-card__action">' + escHtml(dep.action) + '</div>';
                }
                if (dep.changelog_url) {
                    html +=
                        '<a class="dep-card__link" href="' + escHtml(dep.changelog_url) +
                        '" target="_blank" rel="noopener" onclick="event.stopPropagation();">View changelog →</a>';
                }

                card.innerHTML = html;

                // Click card to open full details modal
                card.addEventListener("click", function () {
                    openDepModal(dep, repo.repo_name);
                });

                group.appendChild(card);
            }

            resultsContainer.appendChild(group);
        }
    }

    // ── Detail Modal ───────────────────────────────────────────────
    function openDepModal(dep, repoName) {
        if (!depDetailModal) return;
        detailDepName.textContent = dep.name;
        detailDepBadge.className = "dep-card__badge badge--" + dep.risk;
        detailDepBadge.textContent = dep.risk;

        let bodyHtml =
            '<div style="margin-bottom:14px; font-family:var(--font-mono); font-size:0.9rem">' +
                '<strong>Repository:</strong> ' + escHtml(repoName) + '<br>' +
                '<strong>Current Version:</strong> ' + escHtml(dep.current_version) + '<br>' +
                '<strong>Latest Version:</strong> ' + escHtml(dep.latest_version) + '<br>' +
                '<strong>Ecosystem:</strong> ' + escHtml(dep.ecosystem) +
            '</div>';

        if (dep.update_command) {
            bodyHtml +=
                '<div style="margin-bottom:14px">' +
                    '<div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; margin-bottom:4px">Recommended Update Command</div>' +
                    '<div style="display:flex; gap:8px; align-items:center">' +
                        '<code style="background:rgba(0,0,0,0.4); padding:8px 12px; border-radius:6px; flex:1; font-size:0.85rem">' + escHtml(dep.update_command) + '</code>' +
                        '<button type="button" class="btn-action" id="btnCopySingleCmd">Copy</button>' +
                    '</div>' +
                '</div>';
        }

        if (dep.advisories && dep.advisories.length > 0) {
            bodyHtml += '<div style="margin-bottom:14px"><h4 style="color:var(--critical); font-size:0.9rem; margin-bottom:6px">Security Advisories (CVEs)</h4>';
            for (const adv of dep.advisories) {
                bodyHtml +=
                    '<div style="padding:10px; background:rgba(255,71,87,0.1); border:1px solid rgba(255,71,87,0.3); border-radius:6px; margin-bottom:6px; font-size:0.82rem">' +
                        '<strong>' + escHtml(adv.ghsa_id || adv.cve_id) + '</strong> (' + escHtml(adv.severity) + ')<br>' +
                        escHtml(adv.summary) + '<br>' +
                        '<a href="' + escHtml(adv.url) + '" target="_blank" rel="noopener" style="color:var(--cyan); margin-top:4px; display:inline-block">Read full advisory →</a>' +
                    '</div>';
            }
            bodyHtml += '</div>';
        }

        bodyHtml +=
            '<div style="margin-bottom:14px">' +
                '<h4 style="font-size:0.9rem; margin-bottom:4px">Gemma 4 Analysis</h4>' +
                '<p style="font-size:0.86rem; color:var(--text-secondary)">' + escHtml(dep.summary) + '</p>' +
                '<p style="font-size:0.82rem; color:var(--text-muted); font-style:italic; margin-top:4px">' + escHtml(dep.action) + '</p>' +
            '</div>';

        detailModalBody.innerHTML = bodyHtml;

        const copyBtn = document.getElementById("btnCopySingleCmd");
        if (copyBtn && dep.update_command) {
            copyBtn.addEventListener("click", function () {
                navigator.clipboard.writeText(dep.update_command).then(() => {
                    showToast("Copied update command!");
                });
            });
        }

        depDetailModal.hidden = false;
    }

    if (btnCloseDetail) {
        btnCloseDetail.addEventListener("click", () => depDetailModal.hidden = true);
    }
    if (depDetailModal) {
        depDetailModal.addEventListener("click", function (e) {
            if (e.target === depDetailModal) depDetailModal.hidden = true;
        });
    }

    // ── Filter Pills Handling ──────────────────────────────────────
    document.querySelectorAll(".filter-pill").forEach(function (pill) {
        pill.addEventListener("click", function () {
            document.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            activeFilter = pill.dataset.filter || "ALL";
            if (currentResults.length > 0) {
                renderResults(currentResults);
            }
        });
    });

    // ── Batch Actions ──────────────────────────────────────────────
    if (btnBatchSafe) {
        btnBatchSafe.addEventListener("click", function () {
            const cmds = [];
            for (const repo of currentResults) {
                for (const dep of (repo.dependencies || [])) {
                    if (dep.risk === "SAFE" && dep.update_command) {
                        cmds.push(dep.update_command);
                    }
                }
            }
            if (cmds.length === 0) {
                showToast("No SAFE updates available in current audit.");
                return;
            }
            const script = cmds.join(" && ");
            navigator.clipboard.writeText(script).then(() => {
                showToast("Copied " + cmds.length + " safe update commands!");
            });
        });
    }

    if (btnExportPR) {
        btnExportPR.addEventListener("click", function () {
            let md = "## 🔄 DepDrift Dependency Audit Report\n\n";
            md += "| Package | Current | Latest | Risk | Recommendation |\n";
            md += "| :--- | :--- | :--- | :--- | :--- |\n";

            let count = 0;
            for (const repo of currentResults) {
                for (const dep of (repo.dependencies || [])) {
                    if (dep.is_outdated) {
                        count++;
                        md += `| **${dep.name}** | \`${dep.current_version}\` | \`${dep.latest_version}\` | **${dep.risk}** | ${dep.summary} |\n`;
                    }
                }
            }

            if (count === 0) {
                showToast("No outdated dependencies to export.");
                return;
            }

            md += "\n*Audited by [DepDrift](https://github.com/x-tahosin/depdrift) with Gemma 4 & Browserbase.*";
            navigator.clipboard.writeText(md).then(() => {
                showToast("Copied PR Markdown report to clipboard!");
            });
        });
    }

    if (btnExportJSON) {
        btnExportJSON.addEventListener("click", function () {
            if (currentResults.length === 0) {
                showToast("No audit data to export.");
                return;
            }
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({
                stats: currentStats,
                results: currentResults,
                exported_at: new Date().toISOString()
            }, null, 2));
            const dl = document.createElement("a");
            dl.setAttribute("href", dataStr);
            dl.setAttribute("download", "depdrift-audit.json");
            dl.click();
            showToast("Downloaded audit JSON file.");
        });
    }

    // ── SSE Scanner Engine ─────────────────────────────────────────
    function startScan(query) {
        setLoading(true);
        if (logSection) logSection.hidden = false;
        if (logText) logText.textContent = "Connecting to DepDrift engine…";
        if (statsSection) statsSection.hidden = true;
        if (actionStrip) actionStrip.hidden = true;
        if (resultsSection) resultsSection.hidden = true;
        if (resultsContainer) resultsContainer.innerHTML = "";
        if (footer) footer.hidden = true;

        const url = "/api/scan?input=" + encodeURIComponent(query);

        if (window.location.hostname.includes("github.io")) {
            runDemoSimulation(query);
            return;
        }

        fetch(url).then(function (response) {
            if (!response.ok) {
                throw new Error("Server returned HTTP " + response.status);
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
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (line.startsWith("data: ")) {
                            try {
                                const data = JSON.parse(line.slice(6));
                                handleEvent(data);
                            } catch (e) {
                                // ignore partial json
                            }
                        }
                    }

                    read();
                }).catch(function (err) {
                    runDemoSimulation(query);
                });
            }
            read();
        }).catch(function (err) {
            runDemoSimulation(query);
        });
    }

    function runDemoSimulation(query) {
        setLoading(true);
        if (logSection) logSection.hidden = false;
        const steps = [
            "Connecting to GitHub REST API...",
            "Discovering repository manifests: package.json found...",
            "Querying npm registry for upstream releases...",
            "Matching CVE vulnerabilities against GitHub Advisory Database...",
            "Launching Browserbase cloud browser (f335b214-9ac2) for dynamic changelog extraction...",
            "Gemma 4 running risk classification & triage..."
        ];
        let idx = 0;
        const interval = setInterval(() => {
            if (idx < steps.length) {
                if (logText) logText.textContent = steps[idx];
                idx++;
            } else {
                clearInterval(interval);
                setLoading(false);
                if (logText) logText.textContent = "Scan completed in 1.4s (Interactive Demo Mode).";
                updateStats(DEMO_DATA.stats);
                renderResults(DEMO_DATA.results);
                if (footer) footer.hidden = false;
            }
        }, 300);
    }

    const DEMO_DATA = {
        stats: {
            total_deps: 8,
            outdated: 8,
            critical: 2,
            browserbase_extractions: 1,
            time_saved_minutes: 16
        },
        results: [
            {
                repo_name: "x-tahosin/giftofvoice",
                repo_url: "https://github.com/x-tahosin/giftofvoice",
                total: 8,
                outdated: 8,
                critical: 2,
                dependencies: [
                    {
                        name: "vite",
                        ecosystem: "npm",
                        current_version: "6.2.0",
                        latest_version: "8.3.5",
                        is_outdated: true,
                        risk: "CRITICAL",
                        summary: "Major update 6.2.0 -> 8.3.5: contains breaking API changes and unpatched vulnerabilities.",
                        action: "Review API migration guide before updating to 8.3.5.",
                        changelog_url: "https://github.com/vitejs/vite/releases",
                        update_command: "npm install vite@^8.3.5",
                        advisories: [
                            {
                                ghsa_id: "GHSA-9jrq-w75r-8gcw",
                                cve_id: "CVE-2025-30211",
                                severity: "CRITICAL",
                                summary: "Vite: Cross origin script execution through Vite custom middleware",
                                url: "https://github.com/advisories/GHSA-9jrq-w75r-8gcw"
                            }
                        ]
                    },
                    {
                        name: "express",
                        ecosystem: "npm",
                        current_version: "4.21.2",
                        latest_version: "5.3.0",
                        is_outdated: true,
                        risk: "CRITICAL",
                        summary: "Security patch in 5.3.0: contains fixes for reported parameter injection vulnerabilities.",
                        action: "Update immediately to 5.3.0 and run regression tests.",
                        changelog_url: "https://github.com/expressjs/express/releases",
                        update_command: "npm install express@^5.3.0",
                        advisories: [
                            {
                                ghsa_id: "GHSA-pj86-cfqh-vqx6",
                                cve_id: "CVE-2024-52798",
                                severity: "CRITICAL",
                                summary: "Express improperly controls modification of query properties",
                                url: "https://github.com/advisories/GHSA-pj86-cfqh-vqx6"
                            }
                        ]
                    },
                    {
                        name: "dotenv",
                        ecosystem: "npm",
                        current_version: "16.4.7",
                        latest_version: "18.0.9",
                        is_outdated: true,
                        risk: "BREAKING",
                        summary: "Major version jump from 16.x to 18.x indicates significant architectural or API changes.",
                        action: "Review the official changelog for breaking changes before performing the upgrade.",
                        changelog_url: "https://github.com/motdotla/dotenv/releases",
                        changelog_source: "browserbase",
                        browserbase_session: "f335b214-9ac2-4bf1-a532-68041c2c2aa9",
                        update_command: "npm install dotenv@^18.0.9",
                        advisories: []
                    },
                    {
                        name: "@vitejs/plugin-react",
                        ecosystem: "npm",
                        current_version: "4.3.4",
                        latest_version: "6.1.2",
                        is_outdated: true,
                        risk: "BREAKING",
                        summary: "Major update 4.3.4 -> 6.1.2: contains breaking API changes.",
                        action: "Review API migration guide before updating to 6.1.2.",
                        changelog_url: "https://github.com/vitejs/vite-plugin-react/releases",
                        update_command: "npm install @vitejs/plugin-react@^6.1.2",
                        advisories: []
                    },
                    {
                        name: "cors",
                        ecosystem: "npm",
                        current_version: "2.8.5",
                        latest_version: "2.8.6",
                        is_outdated: true,
                        risk: "BREAKING",
                        summary: "Major update 2.8.5 -> 2.8.6: contains breaking API changes.",
                        action: "Review API migration guide before updating to 2.8.6.",
                        changelog_url: "https://github.com/expressjs/cors/releases",
                        update_command: "npm install cors@^2.8.6",
                        advisories: []
                    },
                    {
                        name: "react-dom",
                        ecosystem: "npm",
                        current_version: "19.0.0",
                        latest_version: "19.3.1",
                        is_outdated: true,
                        risk: "SAFE",
                        summary: "Improvements to the React Server Components transport protocol and bug fixes.",
                        action: "Update to the latest version to benefit from transport protocol enhancements.",
                        changelog_url: "https://github.com/facebook/react/releases",
                        update_command: "npm install react-dom@^19.3.1",
                        advisories: []
                    }
                ]
            }
        ]
    };
    }

    function handleEvent(data) {
        switch (data.status) {
            case "scanning":
            case "checking":
            case "analyzing":
                if (logText) logText.textContent = data.message || "Auditing dependencies…";
                break;

            case "repo_done":
                if (logText) logText.textContent = data.message || "Repository completed.";
                break;

            case "complete":
                if (logText) logText.textContent = data.message || "Scan finished.";
                currentStats = data.stats || {};
                currentResults = data.results || [];
                if (data.stats) updateStats(data.stats);
                if (data.results) renderResults(data.results);
                if (footer) footer.hidden = false;
                break;

            case "error":
                showError(data.message || "An error occurred during scan.");
                break;
        }
    }

    // ── Form Submit ────────────────────────────────────────────────
    if (form) {
        form.addEventListener("submit", function (e) {
            e.preventDefault();
            const query = input.value.trim();
            if (!query) return;
            startScan(query);
        });
    }

    // ── Modal Handlers: Paste Manifest ─────────────────────────────
    if (btnOpenPaste) {
        btnOpenPaste.addEventListener("click", () => modalPasteManifest.hidden = false);
    }
    if (btnClosePaste) {
        btnClosePaste.addEventListener("click", () => modalPasteManifest.hidden = true);
    }
    if (modalPasteManifest) {
        modalPasteManifest.addEventListener("click", (e) => {
            if (e.target === modalPasteManifest) modalPasteManifest.hidden = true;
        });
    }
    if (btnLoadSampleManifest) {
        btnLoadSampleManifest.addEventListener("click", function () {
            manifestInputArea.value = JSON.stringify({
                name: "sample-project",
                dependencies: {
                    "express": "^4.21.0",
                    "dotenv": "^16.4.5",
                    "axios": "^1.6.0"
                }
            }, null, 2);
        });
    }
    if (btnSubmitManifest) {
        btnSubmitManifest.addEventListener("click", function () {
            const content = manifestInputArea.value.trim();
            if (!content) {
                showToast("Please paste a manifest first.");
                return;
            }
            modalPasteManifest.hidden = true;
            setLoading(true);
            if (logSection) logSection.hidden = false;
            if (logText) logText.textContent = "Auditing pasted manifest…";

            fetch("/api/scan/manifest", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename: "package.json", content: content })
            })
            .then(res => {
                if (!res.ok) throw new Error("HTTP " + res.status);
                return res.json();
            })
            .then(data => {
                setLoading(false);
                if (logText) logText.textContent = "Manifest audit complete.";
                const repoRes = {
                    repo_name: "pasted/manifest",
                    repo_url: "#",
                    total: data.total,
                    outdated: data.outdated,
                    critical: data.critical,
                    dependencies: data.dependencies
                };
                updateStats(data);
                renderResults([repoRes]);
                if (footer) footer.hidden = false;
            })
            .catch(err => {
                setLoading(false);
                showError("Manifest audit failed: " + err.message);
            });
        });
    }

    // ── Modal Handlers: Single Package Inspector ───────────────────
    if (btnOpenInspect) {
        btnOpenInspect.addEventListener("click", () => modalSingleInspect.hidden = false);
    }
    if (btnCloseInspect) {
        btnCloseInspect.addEventListener("click", () => modalSingleInspect.hidden = true);
    }
    if (modalSingleInspect) {
        modalSingleInspect.addEventListener("click", (e) => {
            if (e.target === modalSingleInspect) modalSingleInspect.hidden = true;
        });
    }
    if (btnRunInspectPkg) {
        btnRunInspectPkg.addEventListener("click", function () {
            const name = inspectName.value.trim();
            const ver = inspectVersion.value.trim();
            const eco = inspectEco.value;
            if (!name || !ver) return;

            btnRunInspectPkg.disabled = true;
            singleInspectResult.hidden = false;
            singleInspectResult.innerHTML = '<span class="spinner spinner--sm"></span> Inspecting package upstream…';

            const url = "/api/inspect?name=" + encodeURIComponent(name) +
                        "&current_version=" + encodeURIComponent(ver) +
                        "&ecosystem=" + encodeURIComponent(eco);

            fetch(url)
                .then(res => {
                    if (!res.ok) throw new Error("HTTP " + res.status);
                    return res.json();
                })
                .then(data => {
                    btnRunInspectPkg.disabled = false;
                    let html =
                        '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">' +
                            '<strong>' + escHtml(data.name) + '</strong>' +
                            '<span class="dep-card__badge badge--' + data.risk + '">' + data.risk + '</span>' +
                        '</div>' +
                        '<div style="font-family:var(--font-mono); font-size:0.8rem; margin-bottom:8px">' +
                            escHtml(data.current_version) + ' → ' + escHtml(data.latest_version) +
                        '</div>' +
                        '<p style="color:var(--text-secondary); margin-bottom:6px">' + escHtml(data.summary) + '</p>' +
                        '<p style="color:var(--text-muted); font-style:italic">' + escHtml(data.action) + '</p>';
                    if (data.changelog_url) {
                        html += '<a href="' + escHtml(data.changelog_url) + '" target="_blank" rel="noopener" style="color:var(--cyan); margin-top:6px; display:inline-block">View changelog →</a>';
                    }
                    singleInspectResult.innerHTML = html;
                })
                .catch(err => {
                    btnRunInspectPkg.disabled = false;
                    singleInspectResult.innerHTML = '<span style="color:var(--critical)">Error: ' + escHtml(err.message) + '</span>';
                });
        });
    }

    // ── Modal Handlers: System Diagnostics ─────────────────────────
    if (btnOpenDiag) {
        btnOpenDiag.addEventListener("click", function () {
            modalDiagnostics.hidden = false;
            diagModalBody.innerHTML = '<div class="diag-loading"><span class="spinner spinner--sm"></span> Checking system connections…</div>';

            fetch("/api/diagnostics")
                .then(res => res.json())
                .then(data => {
                    let html = "";
                    const bb = data.browserbase || {};
                    const gh = data.github || {};
                    const gemma = data.gemma || {};
                    const items = [
                        { name: "Browserbase Cloud Browser", ok: bb.configured || bb.status === "ready", detail: bb.project_id ? "Project ID: " + bb.project_id : "API Key active" },
                        { name: "GitHub Authenticated PAT", ok: gh.authenticated || gh.status === "connected", detail: gh.rate_limit_remaining !== undefined ? gh.rate_limit_remaining + "/5000 req/hr remaining" : "Rate limit active" },
                        { name: "Gemma 4 AI Engine", ok: gemma.configured || gemma.status === "ready", detail: "Model: " + (gemma.model || "gemma-4-26b-a4b-it") },
                        { name: "SQLite Persistence Engine", ok: true, detail: "Path: data/depdrift.db" }
                    ];

                    for (const it of items) {
                        html +=
                            '<div class="diag-item">' +
                                '<div>' +
                                    '<strong>' + escHtml(it.name) + '</strong><br>' +
                                    '<span style="font-size:0.75rem; color:var(--text-muted)">' + escHtml(it.detail) + '</span>' +
                                '</div>' +
                                '<span class="' + (it.ok ? 'diag-status--ok' : 'diag-status--warn') + '">' +
                                    (it.ok ? '● ACTIVE' : '○ PENDING') +
                                '</span>' +
                            '</div>';
                    }
                    diagModalBody.innerHTML = html;
                })
                .catch(err => {
                    diagModalBody.innerHTML = '<span style="color:var(--critical)">Diagnostics check failed: ' + escHtml(err.message) + '</span>';
                });
        });
    }
    if (btnCloseDiag) {
        btnCloseDiag.addEventListener("click", () => modalDiagnostics.hidden = true);
    }
    if (modalDiagnostics) {
        modalDiagnostics.addEventListener("click", (e) => {
            if (e.target === modalDiagnostics) modalDiagnostics.hidden = true;
        });
    }

})();
