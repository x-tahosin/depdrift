/**
 * DepDrift — Production Client Engine (v2.0.0)
 *
 * Full-featured controller for:
 * - Tab navigation (Scanner, Direct Manifest, Inspector, History, Diagnostics, Docs)
 * - Server-Sent Events (SSE) repository scanner
 * - Direct package.json / requirements.txt manifest auditing
 * - Single package deep inspection
 * - Persistent SQLite audit history management
 * - Infrastructure diagnostics & health checks
 * - Batch safe update scripts & PR markdown / CSV exports
 */

(function () {
    "use strict";

    // ── Global State ───────────────────────────────────────────────
    let currentResults = [];
    let currentStats = {};
    let activeFilter = "ALL";
    let activeSearchTerm = "";

    // ── DOM References ─────────────────────────────────────────────
    const navTabs = document.querySelectorAll(".nav-tab");
    const tabPanes = document.querySelectorAll(".tab-pane");

    // Scanner DOM
    const ghScanForm = document.getElementById("ghScanForm");
    const ghScanInput = document.getElementById("ghScanInput");
    const ghScanBtn = document.getElementById("ghScanBtn");
    const scanStreamPanel = document.getElementById("scanStreamPanel");
    const scanStreamStatus = document.getElementById("scanStreamStatus");
    const scanStreamCounter = document.getElementById("scanStreamCounter");
    const scanStreamLog = document.getElementById("scanStreamLog");
    const auditWorkspace = document.getElementById("auditWorkspace");
    const resultsTableBody = document.getElementById("resultsTableBody");

    // Metrics DOM
    const metricTotal = document.getElementById("metricTotal");
    const metricOutdated = document.getElementById("metricOutdated");
    const metricOutdatedPct = document.getElementById("metricOutdatedPct");
    const metricCritical = document.getElementById("metricCritical");
    const metricBreaking = document.getElementById("metricBreaking");
    const metricSafe = document.getElementById("metricSafe");
    const metricBrowserbase = document.getElementById("metricBrowserbase");

    // Filters & Search
    const filterPills = document.querySelectorAll(".filter-pill");
    const depSearchInput = document.getElementById("depSearchInput");
    const countAll = document.getElementById("countAll");
    const countCritical = document.getElementById("countCritical");
    const countBreaking = document.getElementById("countBreaking");
    const countSafe = document.getElementById("countSafe");
    const countCurrent = document.getElementById("countCurrent");

    // Batch & Export
    const btnBatchSafe = document.getElementById("btnBatchSafe");
    const btnExportMenu = document.getElementById("btnExportMenu");
    const exportDropdown = document.getElementById("exportDropdown");
    const exportMarkdown = document.getElementById("exportMarkdown");
    const exportJSON = document.getElementById("exportJSON");
    const exportCSV = document.getElementById("exportCSV");

    // Manifest Tab DOM
    const manifestTextarea = document.getElementById("manifestTextarea");
    const btnRunManifestAudit = document.getElementById("btnRunManifestAudit");
    const btnLoadExampleManifest = document.getElementById("btnLoadExampleManifest");
    const fileDropZone = document.getElementById("fileDropZone");
    const manifestFileInput = document.getElementById("manifestFileInput");

    // Inspector Tab DOM
    const inspectForm = document.getElementById("inspectForm");
    const inspectPkgName = document.getElementById("inspectPkgName");
    const inspectCurrentVer = document.getElementById("inspectCurrentVer");
    const inspectEcosystem = document.getElementById("inspectEcosystem");
    const btnRunInspect = document.getElementById("btnRunInspect");
    const inspectorResultPanel = document.getElementById("inspectorResultPanel");

    // History Tab DOM
    const historyTableBody = document.getElementById("historyTableBody");
    const btnRefreshHistory = document.getElementById("btnRefreshHistory");

    // Diagnostics Tab DOM
    const btnRunDiagnostics = document.getElementById("btnRunDiagnostics");

    // Modal DOM
    const depDetailModal = document.getElementById("depDetailModal");
    const modalDepName = document.getElementById("modalDepName");
    const modalDepRisk = document.getElementById("modalDepRisk");
    const modalBody = document.getElementById("modalBody");
    const modalCloseBtn = document.getElementById("modalCloseBtn");
    const toastContainer = document.getElementById("toastContainer");

    // ── Toast Helper ───────────────────────────────────────────────
    function showToast(message, duration = 3200) {
        const toast = document.createElement("div");
        toast.className = "toast";
        toast.textContent = message;
        toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = "0";
            toast.style.transform = "translateX(100%)";
            toast.style.transition = "all 0.2s ease";
            setTimeout(() => toast.remove(), 250);
        }, duration);
    }

    // ── Tab Switching ──────────────────────────────────────────────
    function switchTab(tabId) {
        navTabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tabId));
        tabPanes.forEach(p => {
            if (p.id === "tab-" + tabId) {
                p.hidden = false;
                p.classList.add("active");
            } else {
                p.hidden = true;
                p.classList.remove("active");
            }
        });

        if (tabId === "history") loadAuditHistory();
        if (tabId === "diagnostics") loadDiagnostics();
    }

    navTabs.forEach(tab => {
        tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });

    // ── Quick Fill Chips ───────────────────────────────────────────
    document.querySelectorAll(".chip-btn[data-fill]").forEach(btn => {
        btn.addEventListener("click", () => {
            ghScanInput.value = btn.dataset.fill;
            ghScanInput.focus();
        });
    });

    // ── Number Counter Animation ───────────────────────────────────
    function animateNumber(el, target) {
        if (!el) return;
        const start = parseInt(el.textContent, 10) || 0;
        const diff = target - start;
        const duration = 600;
        const startTime = performance.now();

        function step(now) {
            const progress = Math.min((now - startTime) / duration, 1);
            const ease = 1 - Math.pow(1 - progress, 3);
            el.textContent = Math.round(start + diff * ease);
            if (progress < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    function updateMetrics(stats) {
        currentStats = stats;
        const total = stats.total_deps || 0;
        const outdated = stats.outdated || 0;
        const critical = stats.critical || 0;
        const breaking = stats.breaking || 0;
        const safe = stats.safe || 0;
        const bb = stats.browserbase_extractions || 0;

        animateNumber(metricTotal, total);
        animateNumber(metricOutdated, outdated);
        animateNumber(metricCritical, critical);
        animateNumber(metricBreaking, breaking);
        animateNumber(metricSafe, safe);
        animateNumber(metricBrowserbase, bb);

        if (metricOutdatedPct) {
            const pct = total > 0 ? Math.round((outdated / total) * 100) : 0;
            metricOutdatedPct.textContent = `${pct}% of dependency tree`;
        }

        // Update counts in filter pills
        countAll.textContent = total;
        countCritical.textContent = critical;
        countBreaking.textContent = breaking;
        countSafe.textContent = safe;
        countCurrent.textContent = total - outdated;
    }

    // ── Rendering Dependency Cards ─────────────────────────────────
    function renderResults(results) {
        currentResults = results;
        auditWorkspace.hidden = false;
        resultsTableBody.innerHTML = "";

        for (const repo of results) {
            const repoCard = document.createElement("div");
            repoCard.className = "repo-card";

            const header = document.createElement("div");
            header.className = "repo-card__header";
            header.innerHTML = `
                <div class="repo-card__title">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    <a href="${esc(repo.repo_url)}" target="_blank" rel="noopener">${esc(repo.repo_name)}</a>
                </div>
                <div class="text-muted" style="font-size:0.8rem">
                    ${repo.total} dependencies · branch: <code>${esc(repo.default_branch || "main")}</code>
                </div>
            `;
            repoCard.appendChild(header);

            // Filter dependencies
            let deps = repo.dependencies || [];
            if (activeFilter !== "ALL") {
                deps = deps.filter(d => d.risk === activeFilter);
            }
            if (activeSearchTerm) {
                const term = activeSearchTerm.toLowerCase();
                deps = deps.filter(d => d.name.toLowerCase().includes(term));
            }

            // Sort: CRITICAL -> BREAKING -> SAFE -> SKIP -> CURRENT
            const riskOrder = { CRITICAL: 0, BREAKING: 1, SAFE: 2, SKIP: 3, CURRENT: 4 };
            deps = [...deps].sort((a, b) => (riskOrder[a.risk] ?? 5) - (riskOrder[b.risk] ?? 5));

            if (deps.length === 0) {
                const empty = document.createElement("div");
                empty.style.padding = "1.5rem";
                empty.className = "text-center text-muted";
                empty.textContent = "No dependencies match the selected filter.";
                repoCard.appendChild(empty);
            } else {
                for (const dep of deps) {
                    const row = document.createElement("div");
                    row.className = "dep-row";

                    let versionHtml = `<code>${esc(dep.current_version)}</code>`;
                    if (dep.is_outdated) {
                        versionHtml += `<span style="color:var(--text-muted)"> → </span><code class="latest">${esc(dep.latest_version)}</code>`;
                    }

                    let tagsHtml = "";
                    if (dep.changelog_source === "browserbase" || dep.browserbase_session) {
                        const sid = dep.browserbase_session ? dep.browserbase_session.slice(0, 8) : "cloud";
                        tagsHtml += `<span class="bb-tag">🌐 Browserbase (${esc(sid)})</span>`;
                    }
                    if (dep.advisories && dep.advisories.length > 0) {
                        const advCount = dep.advisories.length;
                        tagsHtml += `<span class="cve-tag">⚠ ${advCount} Advisory${advCount > 1 ? "s" : ""}</span>`;
                    }

                    row.innerHTML = `
                        <div class="dep-row__name">
                            <span>${esc(dep.name)}</span>
                            <span class="dep-row__eco">${esc(dep.ecosystem)}</span>
                        </div>
                        <div class="dep-row__version">${versionHtml}</div>
                        <div><span class="badge badge--${esc(dep.risk)}">${esc(dep.risk)}</span></div>
                        <div class="dep-row__summary">${esc(dep.summary || "No summary provided.")}</div>
                        <div class="dep-row__tags">${tagsHtml}</div>
                    `;

                    row.addEventListener("click", () => openDepDetailModal(dep));
                    repoCard.appendChild(row);
                }
            }

            resultsTableBody.appendChild(repoCard);
        }
    }

    // ── Filter & Search Handlers ───────────────────────────────────
    filterPills.forEach(pill => {
        pill.addEventListener("click", () => {
            filterPills.forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            activeFilter = pill.dataset.filter;
            renderResults(currentResults);
        });
    });

    if (depSearchInput) {
        depSearchInput.addEventListener("input", (e) => {
            activeSearchTerm = e.target.value.trim();
            renderResults(currentResults);
        });
    }

    // ── Dependency Detail Modal ────────────────────────────────────
    function openDepDetailModal(dep) {
        modalDepName.textContent = dep.name;
        modalDepRisk.className = `badge badge--${dep.risk}`;
        modalDepRisk.textContent = dep.risk;

        let advisoriesHtml = "";
        if (dep.advisories && dep.advisories.length > 0) {
            advisoriesHtml = `
                <div>
                    <div class="modal-section-title">Security Advisories (CVE / GHSA)</div>
                    <div style="display:flex; flex-direction:column; gap:0.5rem">
                        ${dep.advisories.map(a => `
                            <div style="background:var(--bg-input); padding:0.6rem 0.8rem; border-radius:6px; border:1px solid rgba(239,68,68,0.2)">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem">
                                    <strong style="color:var(--color-critical); font-family:var(--font-mono)">${esc(a.cve_id || a.ghsa_id || "CVE")}</strong>
                                    <span class="badge badge--CRITICAL">${esc(a.severity)}</span>
                                </div>
                                <div style="font-size:0.8rem; color:var(--text-secondary)">${esc(a.summary)}</div>
                                ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener" style="font-size:0.75rem; color:var(--color-accent); display:inline-block; margin-top:0.25rem">View Advisory Details →</a>` : ""}
                            </div>
                        `).join("")}
                    </div>
                </div>
            `;
        }

        let browserbaseHtml = "";
        if (dep.changelog_source === "browserbase" || dep.browserbase_session) {
            browserbaseHtml = `
                <div>
                    <div class="modal-section-title">Browserbase Cloud Browser Extraction</div>
                    <div style="background:var(--bg-input); padding:0.6rem 0.8rem; border-radius:6px; border:1px solid rgba(0,216,246,0.2); font-size:0.8rem; color:var(--text-secondary)">
                        <div><strong>Extraction Mode:</strong> Remote Chrome DevTools Protocol (CDP) session</div>
                        <div><strong>Session ID:</strong> <code>${esc(dep.browserbase_session || "dynamic-cloud-session")}</code></div>
                        <div style="margin-top:0.3rem">Client-side JavaScript and DOM hydrated before text extraction for Gemma 4.</div>
                    </div>
                </div>
            `;
        }

        modalBody.innerHTML = `
            <div>
                <div class="modal-section-title">Version Transition</div>
                <div style="font-family:var(--font-mono); font-size:0.95rem">
                    <code>${esc(dep.current_version)}</code>
                    <span style="color:var(--text-muted)"> → </span>
                    <code style="color:var(--color-accent)">${esc(dep.latest_version)}</code>
                    <span style="font-size:0.8rem; color:var(--text-muted); margin-left:0.5rem">(${esc(dep.ecosystem)})</span>
                </div>
            </div>

            <div>
                <div class="modal-section-title">AI Analysis &amp; Reasoning</div>
                <div style="font-size:0.9rem; color:var(--text-primary); line-height:1.5">${esc(dep.summary || "No summary available.")}</div>
            </div>

            <div>
                <div class="modal-section-title">Recommended Action</div>
                <div style="font-size:0.9rem; color:var(--text-primary); line-height:1.5">${esc(dep.action || "No action specified.")}</div>
            </div>

            ${dep.update_command ? `
                <div>
                    <div class="modal-section-title">Update Command</div>
                    <div class="command-box">
                        <code>${esc(dep.update_command)}</code>
                        <button type="button" class="copy-btn" id="btnCopyModalCmd">Copy</button>
                    </div>
                </div>
            ` : ""}

            ${advisoriesHtml}
            ${browserbaseHtml}

            <div>
                <div class="modal-section-title">External References</div>
                <div style="display:flex; gap:1rem; font-size:0.85rem">
                    ${dep.github_repo_url ? `<a href="${esc(dep.github_repo_url)}" target="_blank" rel="noopener" style="color:var(--color-accent)">GitHub Repo →</a>` : ""}
                    ${dep.changelog_url ? `<a href="${esc(dep.changelog_url)}" target="_blank" rel="noopener" style="color:var(--color-accent)">Release Notes →</a>` : ""}
                    <a href="${dep.ecosystem === 'npm' ? `https://www.npmjs.com/package/${esc(dep.name)}` : `https://pypi.org/project/${esc(dep.name)}/`}" target="_blank" rel="noopener" style="color:var(--color-accent)">Registry Page →</a>
                </div>
            </div>
        `;

        const copyBtn = document.getElementById("btnCopyModalCmd");
        if (copyBtn) {
            copyBtn.addEventListener("click", () => {
                navigator.clipboard.writeText(dep.update_command);
                showToast("Update command copied to clipboard!");
            });
        }

        depDetailModal.hidden = false;
    }

    if (modalCloseBtn) {
        modalCloseBtn.addEventListener("click", () => depDetailModal.hidden = true);
    }
    depDetailModal.addEventListener("click", (e) => {
        if (e.target === depDetailModal) depDetailModal.hidden = true;
    });

    // ── Batch Safe Update Command Generator ───────────────────────
    if (btnBatchSafe) {
        btnBatchSafe.addEventListener("click", () => {
            const safeDeps = [];
            for (const repo of currentResults) {
                for (const dep of repo.dependencies || []) {
                    if (dep.risk === "SAFE" && dep.is_outdated) {
                        safeDeps.push(dep);
                    }
                }
            }

            if (safeDeps.length === 0) {
                showToast("No outdated dependencies in the 'SAFE' category to batch-update.");
                return;
            }

            // Group by ecosystem
            const npmDeps = safeDeps.filter(d => d.ecosystem === "npm");
            const pypiDeps = safeDeps.filter(d => d.ecosystem === "pypi");

            let cmd = "";
            if (npmDeps.length > 0) {
                cmd += "npm install " + npmDeps.map(d => `${d.name}@^${d.latest_version}`).join(" ");
            }
            if (pypiDeps.length > 0) {
                if (cmd) cmd += " && ";
                cmd += "pip install " + pypiDeps.map(d => `${d.name}==${d.latest_version}`).join(" ");
            }

            navigator.clipboard.writeText(cmd);
            showToast(`Copied safe update script for ${safeDeps.length} packages!`);
        });
    }

    // ── Export Menu & Reports ──────────────────────────────────────
    if (btnExportMenu) {
        btnExportMenu.addEventListener("click", (e) => {
            e.stopPropagation();
            exportDropdown.hidden = !exportDropdown.hidden;
        });
        document.addEventListener("click", () => exportDropdown.hidden = true);
    }

    if (exportMarkdown) {
        exportMarkdown.addEventListener("click", () => {
            let md = `# DepDrift Dependency Audit Report\n\n`;
            md += `Generated: ${new Date().toISOString()}\n\n`;
            md += `## Summary Metrics\n\n`;
            md += `- **Total Dependencies:** ${currentStats.total_deps || 0}\n`;
            md += `- **Outdated Drift:** ${currentStats.outdated || 0}\n`;
            md += `- **Critical CVEs:** ${currentStats.critical || 0}\n`;
            md += `- **Breaking Changes:** ${currentStats.breaking || 0}\n`;
            md += `- **Safe to Bump:** ${currentStats.safe || 0}\n\n`;

            md += `## Detailed Package Findings\n\n`;
            md += `| Package | Current | Latest | Risk | Summary | Recommended Action |\n`;
            md += `|---|---|---|---|---|---|\n`;

            for (const repo of currentResults) {
                for (const dep of repo.dependencies || []) {
                    if (dep.is_outdated) {
                        md += `| **${dep.name}** | \`${dep.current_version}\` | \`${dep.latest_version}\` | **${dep.risk}** | ${dep.summary.replace(/\|/g, '-')} | ${dep.action.replace(/\|/g, '-')} |\n`;
                    }
                }
            }

            navigator.clipboard.writeText(md);
            showToast("GitHub PR Markdown report copied to clipboard!");
        });
    }

    if (exportJSON) {
        exportJSON.addEventListener("click", () => {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({
                generated_at: new Date().toISOString(),
                stats: currentStats,
                results: currentResults
            }, null, 2));
            const dl = document.createElement("a");
            dl.setAttribute("href", dataStr);
            dl.setAttribute("download", `depdrift_audit_${Date.now()}.json`);
            dl.click();
            showToast("Downloaded JSON audit file!");
        });
    }

    if (exportCSV) {
        exportCSV.addEventListener("click", () => {
            let csv = "Repository,Package,Ecosystem,CurrentVersion,LatestVersion,Risk,Summary,UpdateCommand\n";
            for (const repo of currentResults) {
                for (const dep of repo.dependencies || []) {
                    csv += `"${repo.repo_name}","${dep.name}","${dep.ecosystem}","${dep.current_version}","${dep.latest_version}","${dep.risk}","${(dep.summary || '').replace(/"/g, '""')}","${(dep.update_command || '').replace(/"/g, '""')}"\n`;
                }
            }
            const dataStr = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
            const dl = document.createElement("a");
            dl.setAttribute("href", dataStr);
            dl.setAttribute("download", `depdrift_audit_${Date.now()}.csv`);
            dl.click();
            showToast("Downloaded CSV audit file!");
        });
    }

    // ── Repository Scanner (SSE) ───────────────────────────────────
    function startGithubScan(target) {
        ghScanBtn.disabled = true;
        ghScanBtn.querySelector(".btn__text").hidden = true;
        ghScanBtn.querySelector(".btn__loader").hidden = false;

        scanStreamPanel.hidden = false;
        scanStreamStatus.textContent = "Connecting to GitHub & registries…";
        scanStreamCounter.textContent = "";
        scanStreamLog.innerHTML = "";
        auditWorkspace.hidden = true;

        const url = "/api/scan?input=" + encodeURIComponent(target);
        fetch(url).then(res => {
            if (!res.ok) throw new Error(`HTTP error ${res.status}`);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            function read() {
                reader.read().then(({ done, value }) => {
                    if (done) {
                        ghScanBtn.disabled = false;
                        ghScanBtn.querySelector(".btn__text").hidden = false;
                        ghScanBtn.querySelector(".btn__loader").hidden = true;
                        return;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (line.startsWith("data: ")) {
                            try {
                                const payload = JSON.parse(line.slice(6));
                                handleScanEvent(payload);
                            } catch (e) {}
                        }
                    }
                    read();
                }).catch(err => {
                    scanStreamStatus.textContent = "Stream error: " + err.message;
                    ghScanBtn.disabled = false;
                    ghScanBtn.querySelector(".btn__text").hidden = false;
                    ghScanBtn.querySelector(".btn__loader").hidden = true;
                });
            }
            read();
        }).catch(err => {
            scanStreamStatus.textContent = "Connection failed: " + err.message;
            ghScanBtn.disabled = false;
            ghScanBtn.querySelector(".btn__text").hidden = false;
            ghScanBtn.querySelector(".btn__loader").hidden = true;
        });
    }

    function handleScanEvent(data) {
        if (data.message) {
            scanStreamStatus.textContent = data.message;
            const logItem = document.createElement("div");
            logItem.textContent = `[${new Date().toLocaleTimeString()}] ${data.message}`;
            scanStreamLog.appendChild(logItem);
            scanStreamLog.scrollTop = scanStreamLog.scrollHeight;
        }

        if (data.progress) {
            scanStreamCounter.textContent = data.progress;
        }

        if (data.status === "complete") {
            scanStreamStatus.textContent = `Scan completed: ${data.message}`;
            if (data.stats) updateMetrics(data.stats);
            if (data.results) renderResults(data.results);
            showToast("Repository scan completed successfully!");
        } else if (data.status === "error") {
            scanStreamStatus.textContent = `Error: ${data.message}`;
            showToast("Scan failed: " + data.message);
        }
    }

    if (ghScanForm) {
        ghScanForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const val = ghScanInput.value.trim();
            if (val) startGithubScan(val);
        });
    }

    // ── Direct Manifest Tab ────────────────────────────────────────
    if (btnLoadExampleManifest) {
        btnLoadExampleManifest.addEventListener("click", () => {
            manifestTextarea.value = JSON.stringify({
                "name": "my-production-app",
                "version": "1.0.0",
                "dependencies": {
                    "express": "^4.21.0",
                    "dotenv": "^16.4.5",
                    "cors": "^2.8.5",
                    "react": "^18.3.1",
                    "react-dom": "^18.3.1",
                    "lucide-react": "^0.300.0"
                }
            }, null, 2);
            showToast("Example package.json loaded into editor.");
        });
    }

    if (btnRunManifestAudit) {
        btnRunManifestAudit.addEventListener("click", async () => {
            const content = manifestTextarea.value.trim();
            if (!content) {
                showToast("Please paste manifest content or drop a file first.");
                return;
            }

            const isJson = content.startsWith("{");
            const filename = isJson ? "package.json" : "requirements.txt";

            btnRunManifestAudit.disabled = true;
            btnRunManifestAudit.querySelector(".btn__text").hidden = true;
            btnRunManifestAudit.querySelector(".btn__loader").hidden = false;

            try {
                const res = await fetch("/api/scan/manifest", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ filename, content })
                });

                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || "Manifest scan failed");
                }

                const data = await res.json();
                switchTab("scanner");
                if (data.stats) updateMetrics(data.stats);
                if (data.results) renderResults(data.results);
                showToast("Manifest audit completed!");
            } catch (err) {
                showToast("Error: " + err.message);
            } finally {
                btnRunManifestAudit.disabled = false;
                btnRunManifestAudit.querySelector(".btn__text").hidden = false;
                btnRunManifestAudit.querySelector(".btn__loader").hidden = true;
            }
        });
    }

    // Drag and drop for manifest file
    if (fileDropZone) {
        fileDropZone.addEventListener("click", () => manifestFileInput.click());
        fileDropZone.addEventListener("dragover", (e) => {
            e.preventDefault();
            fileDropZone.style.borderColor = "var(--color-accent)";
        });
        fileDropZone.addEventListener("dragleave", () => fileDropZone.style.borderColor = "");
        fileDropZone.addEventListener("drop", (e) => {
            e.preventDefault();
            fileDropZone.style.borderColor = "";
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleManifestFile(e.dataTransfer.files[0]);
            }
        });
        manifestFileInput.addEventListener("change", (e) => {
            if (e.target.files && e.target.files[0]) {
                handleManifestFile(e.target.files[0]);
            }
        });
    }

    function handleManifestFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            manifestTextarea.value = e.target.result;
            showToast(`Loaded ${file.name} into editor.`);
        };
        reader.readAsText(file);
    }

    // ── Single Package Inspector ───────────────────────────────────
    if (inspectForm) {
        inspectForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const name = inspectPkgName.value.trim();
            const current_version = inspectCurrentVer.value.trim();
            const ecosystem = inspectEcosystem.value;

            btnRunInspect.disabled = true;
            btnRunInspect.querySelector(".btn__text").hidden = true;
            btnRunInspect.querySelector(".btn__loader").hidden = false;

            try {
                const res = await fetch("/api/inspect", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, current_version, ecosystem })
                });

                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const dep = await res.json();

                inspectorResultPanel.hidden = false;
                inspectorResultPanel.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem">
                        <div>
                            <h2 style="font-size:1.4rem; font-family:var(--font-mono); color:#fff">${esc(dep.name)}</h2>
                            <div style="color:var(--text-muted); font-size:0.8rem">${esc(dep.ecosystem)} package</div>
                        </div>
                        <span class="badge badge--${esc(dep.risk)}">${esc(dep.risk)}</span>
                    </div>

                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:1rem; margin-bottom:1.25rem">
                        <div style="background:var(--bg-input); padding:0.75rem 1rem; border-radius:6px">
                            <span class="text-muted" style="font-size:0.75rem; text-transform:uppercase">Current Version</span>
                            <div style="font-family:var(--font-mono); font-size:1.1rem; color:#fff"><code>${esc(dep.current_version)}</code></div>
                        </div>
                        <div style="background:var(--bg-input); padding:0.75rem 1rem; border-radius:6px">
                            <span class="text-muted" style="font-size:0.75rem; text-transform:uppercase">Latest Upstream</span>
                            <div style="font-family:var(--font-mono); font-size:1.1rem; color:var(--color-accent)"><code>${esc(dep.latest_version)}</code></div>
                        </div>
                        <div style="background:var(--bg-input); padding:0.75rem 1rem; border-radius:6px">
                            <span class="text-muted" style="font-size:0.75rem; text-transform:uppercase">Drift Status</span>
                            <div style="font-size:1.1rem; font-weight:600; color:${dep.is_outdated ? 'var(--color-breaking)' : 'var(--color-safe)'}">
                                ${dep.is_outdated ? "Outdated" : "Current"}
                            </div>
                        </div>
                    </div>

                    <div style="margin-bottom:1rem">
                        <div class="modal-section-title">Gemma 4 Risk Assessment</div>
                        <div style="color:var(--text-primary); font-size:0.95rem; line-height:1.5">${esc(dep.summary)}</div>
                    </div>

                    <div style="margin-bottom:1.25rem">
                        <div class="modal-section-title">Recommended Remediation</div>
                        <div style="color:var(--text-primary); font-size:0.95rem; line-height:1.5">${esc(dep.action)}</div>
                    </div>

                    ${dep.update_command ? `
                        <div style="margin-bottom:1.25rem">
                            <div class="modal-section-title">Update Snippet</div>
                            <div class="command-box">
                                <code>${esc(dep.update_command)}</code>
                                <button type="button" class="copy-btn" onclick="navigator.clipboard.writeText('${esc(dep.update_command)}'); showToast('Copied update command!');">Copy</button>
                            </div>
                        </div>
                    ` : ""}

                    ${dep.advisories && dep.advisories.length > 0 ? `
                        <div style="margin-bottom:1.25rem">
                            <div class="modal-section-title">Security Advisories (${dep.advisories.length})</div>
                            <div style="display:flex; flex-direction:column; gap:0.5rem">
                                ${dep.advisories.map(a => `
                                    <div style="background:var(--bg-input); padding:0.6rem 0.8rem; border-radius:6px; border:1px solid rgba(239,68,68,0.2)">
                                        <div style="display:flex; justify-content:space-between">
                                            <strong style="color:var(--color-critical)">${esc(a.cve_id || a.ghsa_id)}</strong>
                                            <span class="badge badge--CRITICAL">${esc(a.severity)}</span>
                                        </div>
                                        <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.25rem">${esc(a.summary)}</div>
                                    </div>
                                `).join("")}
                            </div>
                        </div>
                    ` : ""}

                    ${dep.changelog_source === "browserbase" ? `
                        <div style="background:rgba(0,216,246,0.06); border:1px solid rgba(0,216,246,0.2); border-radius:6px; padding:0.75rem; font-size:0.8rem; color:var(--color-browserbase)">
                            🌐 Hydrated changelog was rendered and extracted via Browserbase headless cloud browser session (ID: ${esc(dep.browserbase_session || 'cloud')}).
                        </div>
                    ` : ""}
                `;
            } catch (err) {
                showToast("Inspection failed: " + err.message);
            } finally {
                btnRunInspect.disabled = false;
                btnRunInspect.querySelector(".btn__text").hidden = false;
                btnRunInspect.querySelector(".btn__loader").hidden = true;
            }
        });
    }

    // ── Audit History Tab ──────────────────────────────────────────
    async function loadAuditHistory() {
        historyTableBody.innerHTML = `<tr><td colspan="9" class="text-center text-muted">Loading audit records from SQLite…</td></tr>`;
        try {
            const res = await fetch("/api/history?limit=30");
            const audits = await res.json();

            if (!audits || audits.length === 0) {
                historyTableBody.innerHTML = `<tr><td colspan="9" class="text-center text-muted">No audit history found. Run a scan to persist results.</td></tr>`;
                return;
            }

            historyTableBody.innerHTML = "";
            for (const item of audits) {
                const tr = document.createElement("tr");
                const dateStr = new Date(item.created_at * 1000).toLocaleString();

                tr.innerHTML = `
                    <td><strong>${esc(item.target)}</strong></td>
                    <td><span class="badge badge--SKIP">${esc(item.target_type)}</span></td>
                    <td class="text-muted">${esc(dateStr)}</td>
                    <td>${item.total_deps}</td>
                    <td><span style="color:var(--color-breaking); font-weight:600">${item.outdated_count}</span></td>
                    <td><span class="badge badge--CRITICAL">${item.critical_count}</span></td>
                    <td><span class="badge badge--BREAKING">${item.breaking_count || 0}</span></td>
                    <td><span class="badge badge--SAFE">${item.safe_count || 0}</span></td>
                    <td>
                        <button type="button" class="btn btn--outline btn--sm" data-action="load" data-id="${item.id}">View</button>
                        <button type="button" class="btn btn--outline btn--sm" data-action="delete" data-id="${item.id}" style="color:var(--color-critical)">Delete</button>
                    </td>
                `;

                tr.querySelector('[data-action="load"]').addEventListener("click", () => loadPastAudit(item.id));
                tr.querySelector('[data-action="delete"]').addEventListener("click", () => deletePastAudit(item.id));
                historyTableBody.appendChild(tr);
            }
        } catch (err) {
            historyTableBody.innerHTML = `<tr><td colspan="9" class="text-center" style="color:var(--color-critical)">Failed to load history: ${esc(err.message)}</td></tr>`;
        }
    }

    async function loadPastAudit(id) {
        try {
            const res = await fetch(`/api/history/${id}`);
            if (!res.ok) throw new Error("Could not load audit");
            const data = await res.json();
            switchTab("scanner");
            if (data.stats) updateMetrics(data.stats);
            if (data.results) renderResults(data.results);
            showToast(`Loaded audit record #${id} (${data.target})`);
        } catch (err) {
            showToast("Failed to load audit: " + err.message);
        }
    }

    async function deletePastAudit(id) {
        if (!confirm(`Delete audit record #${id}?`)) return;
        try {
            const res = await fetch(`/api/history/${id}`, { method: "DELETE" });
            if (!res.ok) throw new Error("Delete failed");
            showToast(`Deleted audit #${id}`);
            loadAuditHistory();
        } catch (err) {
            showToast("Error: " + err.message);
        }
    }

    if (btnRefreshHistory) btnRefreshHistory.addEventListener("click", loadAuditHistory);

    // ── Diagnostics Tab ────────────────────────────────────────────
    async function loadDiagnostics() {
        const diagGrid = document.getElementById("diagnosticsGrid");
        try {
            const res = await fetch("/api/diagnostics");
            const data = await res.json();

            // GitHub
            const ghInd = document.getElementById("diagGithubInd");
            const ghBody = document.getElementById("diagGithubBody");
            if (data.github.status === "connected") {
                ghInd.className = "status-indicator status-indicator--green";
                ghBody.innerHTML = `
                    <div><strong>Status:</strong> Connected &amp; Authenticated</div>
                    <div><strong>Rate Limit:</strong> ${data.github.rate_limit_remaining} / ${data.github.rate_limit_limit} req/hr</div>
                    <div><strong>Auth:</strong> Personal Access Token configured</div>
                `;
            } else {
                ghInd.className = "status-indicator status-indicator--gray";
                ghBody.innerHTML = `<div>Status: ${esc(data.github.status)}</div>`;
            }

            // Browserbase
            const bbInd = document.getElementById("diagBrowserbaseInd");
            const bbBody = document.getElementById("diagBrowserbaseBody");
            if (data.browserbase.status === "ready") {
                bbInd.className = "status-indicator status-indicator--green";
                bbBody.innerHTML = `
                    <div><strong>Status:</strong> Cloud Headless Browser Operational</div>
                    <div><strong>API Key:</strong> Configured</div>
                    <div><strong>Project ID:</strong> ${esc(data.browserbase.project_id || 'default')}</div>
                    <div><strong>Protocol:</strong> Playwright over CDP</div>
                `;
            } else {
                bbInd.className = "status-indicator status-indicator--gray";
                bbBody.innerHTML = `<div>Status: ${esc(data.browserbase.status)}</div>`;
            }

            // Gemma
            const gmInd = document.getElementById("diagGemmaInd");
            const gmBody = document.getElementById("diagGemmaBody");
            if (data.gemma.status === "ready") {
                gmInd.className = "status-indicator status-indicator--green";
                gmBody.innerHTML = `
                    <div><strong>Status:</strong> Open Weights Ready</div>
                    <div><strong>Model:</strong> ${esc(data.gemma.model)}</div>
                    <div><strong>Provider:</strong> ${esc(data.gemma.provider)}</div>
                    <div><strong>Inference:</strong> Low-temp structured JSON validation</div>
                `;
            } else {
                gmInd.className = "status-indicator status-indicator--gray";
                gmBody.innerHTML = `<div>Status: ${esc(data.gemma.status)}</div>`;
            }

            // Registries
            const regInd = document.getElementById("diagRegistriesInd");
            const regBody = document.getElementById("diagRegistriesBody");
            const npmOp = data.registries.npm === "operational";
            const pypiOp = data.registries.pypi === "operational";
            regInd.className = `status-indicator ${npmOp && pypiOp ? 'status-indicator--green' : 'status-indicator--gray'}`;
            regBody.innerHTML = `
                <div><strong>npm Registry:</strong> ${npmOp ? 'Operational (registry.npmjs.org)' : 'Degraded'}</div>
                <div><strong>PyPI Registry:</strong> ${pypiOp ? 'Operational (pypi.org)' : 'Degraded'}</div>
                <div><strong>Semver Parsing:</strong> Native semver resolution</div>
            `;
        } catch (err) {
            showToast("Diagnostics check failed: " + err.message);
        }
    }

    if (btnRunDiagnostics) btnRunDiagnostics.addEventListener("click", loadDiagnostics);

    // ── Ambient Background Canvas ──────────────────────────────────
    (function initAmbient() {
        const canvas = document.getElementById("ambient-canvas");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        let w, h;
        const dots = [];
        const COUNT = 45;

        function resize() {
            w = canvas.width = window.innerWidth;
            h = canvas.height = window.innerHeight;
        }
        resize();
        window.addEventListener("resize", resize);

        for (let i = 0; i < COUNT; i++) {
            dots.push({
                x: Math.random() * w,
                y: Math.random() * h,
                r: Math.random() * 1.5 + 0.5,
                vx: (Math.random() - 0.5) * 0.25,
                vy: (Math.random() - 0.5) * 0.25,
                a: Math.random() * 0.5 + 0.15
            });
        }

        function loop() {
            ctx.clearRect(0, 0, w, h);
            for (const d of dots) {
                d.x += d.vx;
                d.y += d.vy;
                if (d.x < 0) d.x = w;
                if (d.x > w) d.x = 0;
                if (d.y < 0) d.y = h;
                if (d.y > h) d.y = 0;

                ctx.beginPath();
                ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(56, 189, 248, ${d.a})`;
                ctx.fill();
            }
            requestAnimationFrame(loop);
        }
        loop();
    })();

    // ── Helper: Escape HTML ────────────────────────────────────────
    function esc(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // ── Initial Check ──────────────────────────────────────────────
    fetch("/api/diagnostics").then(r => r.json()).then(data => {
        const badge = document.getElementById("systemStatusText");
        if (data.github && data.github.rate_limit_remaining) {
            badge.textContent = `Operational · Rate Limit: ${data.github.rate_limit_remaining}/5000`;
        }
    }).catch(() => {});

})();
