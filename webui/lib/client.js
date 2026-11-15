window.__ModuleLoader__.load({
	id: "wheelchair-agent-webui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const { jsx, jsxs } = react_jsx_runtime;

		/** Namespace of this package's locale dictionaries and slot declarations. */
		const NS = "wheelchair-agent-webui";
		/**
		* Id of the wheelchair-agent UI home panel. It is shared by the sidebar row
		* and the `main` page registration, and it is the same in both languages: the
		* panel is the product entry, whose first section is the review inbox.
		*/
		const PANEL_ID = "wheelchair-agent";
		/** The two JSON endpoints the inbox already serves; the panel only reads them. */
		const ITEMS_URL = "/wheelchair-inbox/items";
		const REVIEW_URL = "/wheelchair-inbox/review";

		/** Copy for the panel, the inbox section and the Markdown chrome. */
		const zh = {
			panel: "wheelchair-agent",
			"panel.subtitle": "功能面板：wheelchair-agent 的各项工作流",
			"nav.features": "功能",
			"sections.label": "功能",
			"section.inbox": "收件箱",
			"feature.inbox.title": "收件箱",
			"feature.inbox.description": "审查 GitHub PR：通过，或指出问题并派给 worker。",
			refresh: "刷新",
			"filter.label": "筛选",
			"filter.all": "全部",
			"filter.pending": "待审",
			"filter.issue": "有问题",
			"filter.approved": "已通过",
			"filter.empty": "这个筛选下没有 PR。",
			"status.loading": "加载中…",
			"status.loaded": "{count} 个 PR · 更新于 {time}",
			"status.failed": "加载失败：{message}",
			"inbox.empty": "收件箱是空的。先运行 “wheelchair-agent inbox watch --once” 拉取 PR。",
			"card.untitled": "（无标题）",
			"card.files": "{count} 个文件",
			"card.body": "PR 说明",
			"card.bodyEmpty": "（PR 正文为空）",
			"card.open": "打开 PR",
			"card.reviews": "审查记录（{count}）",
			"status.pending": "待审",
			"status.approved": "已通过",
			"status.issue": "有问题",
			"form.pass": "通过",
			"form.issue": "有问题",
			"form.issuePlaceholder": "写清楚问题在哪；提交后会派给 worker。",
			"form.issueEmpty": "请写下问题再提交。",
			"form.submit": "提交评论",
			"form.cancel": "取消",
			"form.failed": "提交失败：{message}",
			"form.inflight": "提交中…",
			"state.open": "OPEN",
			"state.merged": "MERGED",
			"state.closed": "CLOSED"
		};
		const en = {
			panel: "wheelchair-agent",
			"panel.subtitle": "Feature host: wheelchair-agent workflows",
			"nav.features": "Features",
			"sections.label": "Features",
			"section.inbox": "Inbox",
			"feature.inbox.title": "Inbox",
			"feature.inbox.description": "Review GitHub pull requests: approve them, or flag an issue and dispatch it to a worker.",
			refresh: "Refresh",
			"filter.label": "Filter",
			"filter.all": "All",
			"filter.pending": "Pending",
			"filter.issue": "Issues",
			"filter.approved": "Approved",
			"filter.empty": "No pull requests in this filter.",
			"status.loading": "Loading…",
			"status.loaded": "{count} PRs · updated {time}",
			"status.failed": "Could not load: {message}",
			"inbox.empty": "The inbox is empty. Run “wheelchair-agent inbox watch --once” to fetch pull requests.",
			"card.untitled": "(untitled)",
			"card.files": "{count} files",
			"card.body": "PR description",
			"card.bodyEmpty": "(No PR description)",
			"card.open": "Open PR",
			"card.reviews": "Review history ({count})",
			"status.pending": "Pending",
			"status.approved": "Approved",
			"status.issue": "Issue",
			"form.pass": "Approve",
			"form.issue": "Flag issue",
			"form.issuePlaceholder": "Describe the problem; submitting dispatches it to a worker.",
			"form.issueEmpty": "Describe the issue before submitting.",
			"form.submit": "Submit comment",
			"form.cancel": "Cancel",
			"form.failed": "Could not submit: {message}",
			"form.inflight": "Submitting…",
			"state.open": "OPEN",
			"state.merged": "MERGED",
			"state.closed": "CLOSED"
		};

		/**
		* The sidebar glyph: a small inbox outline. The shell passes `size` (and
		* `active`, which this icon does not use); `active` is accepted and ignored so
		* the panel row renders in both wide and narrow columns.
		* @param props - shell-supplied icon presentation.
		* @returns the inbox glyph.
		*/
		function InboxIcon(props) {
			const size = typeof props?.size === "number" ? props.size : 16;
			return jsxs("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					jsx("path", { d: "M2 9.5h3l1 1.8h4l1-1.8h3" }, "tray"),
					jsx("path", { d: "M2.8 9.5V4.2A1.2 1.2 0 0 1 4 3h8a1.2 1.2 0 0 1 1.2 1.2v5.3" }, "top"),
					jsx("path", { d: "M2.8 9.5v2.3A1.2 1.2 0 0 0 4 13h8a1.2 1.2 0 0 0 1.2-1.2V9.5" }, "bottom")
				]
			});
		}

		//#region inline SVG glyphs owned by this plugin
		/** The disclosure chevron; rotation is CSS so no second icon is needed. */
		function ChevronIcon(props) {
			return jsx("svg", {
				className: "wca-chevron",
				"data-open": props.open ? "true" : "false",
				width: 14,
				height: 14,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: jsx("path", { d: "M6 3.5 10.5 8 6 12.5" })
			});
		}
		//#endregion

		//#region Markdown -> React
		//
		// A small, dependency-free CommonMark subset, enough to read a PR body: ATX
		// headings, unordered/ordered (nested) lists, fenced code, inline code, bold,
		// italic, strikethrough, links, blockquotes, horizontal rules, GFM pipe tables
		// and paragraphs. It deliberately does NOT support raw HTML (text becomes React
		// children, so nothing is injected), images, footnotes or math.

		const ESCAPABLE = "\\`*_{}[]()#+-.!|>~";
		const BLOCK_START = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|>|(?:[-*+]|\d+[.)])[ \t])/;

		/** Count the run of one character starting at `at`. */
		function runLength(text, at, char) {
			let end = at;
			while (end < text.length && text.charAt(end) === char) end += 1;
			return end - at;
		}

		/** Leading spaces of a line; tabs stay literal (collapsing them would corrupt code). */
		function indentOf(line) {
			let end = 0;
			while (end < line.length && line.charAt(end) === " ") end += 1;
			return end;
		}

		/** Normalize CRLF; tab expansion would corrupt tabs inside fenced code. */
		function normalizeSource(text) {
			return String(text ?? "").replace(/\r\n?/g, "\n");
		}

		/** A link destination React may follow: absolute http(s), mailto and protocol-relative. */
		function safeHref(value) {
			const raw = String(value ?? "").trim();
			if (raw === "") return undefined;
			if (!/^(?:https?:|mailto:|\/\/)/i.test(raw)) return undefined;
			try {
				const url = new URL(raw, "https://github.invalid/");
				if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return raw;
			} catch {
				return undefined;
			}
			return undefined;
		}

		/** http(s) only, for the "open PR" link the inbox item carries. */
		function safeWebHref(value) {
			try {
				const url = new URL(String(value ?? ""));
				return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
			} catch {
				return undefined;
			}
		}

		/** Parse an inline `[label](destination "title")` at `at`; undefined when malformed. */
		function parseLink(text, at) {
			if (text.charAt(at) !== "[") return undefined;
			let depth = 0;
			let close = -1;
			for (let index = at; index < text.length; index += 1) {
				const char = text.charAt(index);
				if (char === "\\") {
					index += 1;
					continue;
				}
				if (char === "[") depth += 1;
				else if (char === "]") {
					depth -= 1;
					if (depth === 0) {
						close = index;
						break;
					}
				}
			}
			if (close === -1 || text.charAt(close + 1) !== "(") return undefined;
			let parenthesis = 1;
			let end = -1;
			for (let index = close + 2; index < text.length; index += 1) {
				const char = text.charAt(index);
				if (char === "\\") {
					index += 1;
					continue;
				}
				if (char === "(") parenthesis += 1;
				else if (char === ")") {
					parenthesis -= 1;
					if (parenthesis === 0) {
						end = index;
						break;
					}
				}
			}
			if (end === -1) return undefined;
			const inside = text.slice(close + 2, end).trim();
			const match = /^(<[^<>\s]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*$/.exec(inside);
			if (match === null) return undefined;
			let destination = match[1];
			if (destination.startsWith("<") && destination.endsWith(">")) destination = destination.slice(1, -1);
			const href = safeHref(destination);
			if (href === undefined) return undefined;
			return { label: text.slice(at + 1, close), href, end: end + 1 };
		}

		/**
		* Render inline Markdown into React children.
		* @param text - inline source, possibly containing soft line breaks.
		* @param keyPrefix - stable prefix for generated keys.
		* @param inLink - true while rendering a link label, where nested links are invalid.
		* @returns React children (strings and elements).
		*/
		function inlineNodes(text, keyPrefix, inLink = false) {
			const nodes = [];
			let buffer = "";
			const flush = () => {
				if (buffer !== "") {
					nodes.push(buffer);
					buffer = "";
				}
			};
			const push = (element) => {
				flush();
				nodes.push(element);
			};
			let index = 0;
			while (index < text.length) {
				const char = text.charAt(index);
				if (char === "\\") {
					const next = text.charAt(index + 1);
					if (next === "\n") {
						buffer = buffer.replace(/[ \t]+$/, "");
						push(jsx("br", {}, `${keyPrefix}br${nodes.length}`));
						index += 2;
						continue;
					}
					if (ESCAPABLE.includes(next)) {
						buffer += next;
						index += 2;
						continue;
					}
					buffer += char;
					index += 1;
					continue;
				}
				if (char === "\n") {
					if (/[ ]{2,}$/.test(buffer)) {
						buffer = buffer.replace(/[ \t]+$/, "");
						push(jsx("br", {}, `${keyPrefix}br${nodes.length}`));
					} else if (buffer !== "" && !buffer.endsWith(" ")) {
						buffer += " ";
					}
					index += 1;
					continue;
				}
				if (char === "`") {
					const run = runLength(text, index, "`");
					const close = text.indexOf("`".repeat(run), index + run);
					if (close !== -1) {
						let code = text.slice(index + run, close);
						if (code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
						push(jsx("code", { children: code }, `${keyPrefix}code${nodes.length}`));
						index = close + run;
						continue;
					}
					buffer += text.slice(index, index + run);
					index += run;
					continue;
				}
				// Images are unsupported; show their alt text as a plain link to the image, not "!" + link.
				if (char === "!" && !inLink && text.charAt(index + 1) === "[") {
					const image = parseLink(text, index + 1);
					if (image !== undefined) {
						const alt = image.label.trim();
						push(
							jsx(
								"a",
								{
									className: "wca-image-link",
									href: image.href,
									target: "_blank",
									rel: "noopener noreferrer",
									title: image.href,
									children: alt === "" ? "image" : alt
								},
								`${keyPrefix}image${nodes.length}`
							)
						);
						index = image.end;
						continue;
					}
				}
				if (char === "[" && !inLink) {
					const link = parseLink(text, index);
					if (link !== undefined) {
						push(
							jsx(
								"a",
								{
									href: link.href,
									target: "_blank",
									rel: "noopener noreferrer",
									children: inlineNodes(link.label, `${keyPrefix}link${nodes.length}-`, true)
								},
								`${keyPrefix}link${nodes.length}`
							)
						);
						index = link.end;
						continue;
					}
				}
				if (char === "*" || char === "_") {
					const previous = index === 0 ? "" : text.charAt(index - 1);
					// Underscores inside a word (snake_case) are literal; asterisks may sit inside one.
					const intraword = char === "_" && /[A-Za-z0-9]/.test(previous);
					const run = runLength(text, index, char);
					if (run >= 3 && !intraword) {
						const triple = new RegExp(`^\\${char}{3}(?=\\S)([\\s\\S]*?\\S)\\${char}{3}`).exec(
							text.slice(index)
						);
						if (triple !== null) {
							push(
								jsx(
									"strong",
									{
										children: jsx("em", {
											children: inlineNodes(triple[1], `${keyPrefix}emstrong${nodes.length}-`, inLink)
										})
									},
									`${keyPrefix}emstrong${nodes.length}`
								)
							);
							index += triple[0].length;
							continue;
						}
					}
					const strong = new RegExp(`^\\${char}{2}(?=\\S)([\\s\\S]*?\\S)\\${char}{2}`).exec(text.slice(index));
					if (strong !== null && !intraword) {
						push(
							jsx(
								"strong",
								{ children: inlineNodes(strong[1], `${keyPrefix}strong${nodes.length}-`, inLink) },
								`${keyPrefix}strong${nodes.length}`
							)
						);
						index += strong[0].length;
						continue;
					}
					const emphasis = new RegExp(`^\\${char}(?=\\S)([\\s\\S]*?\\S)\\${char}`).exec(text.slice(index));
					if (emphasis !== null && !intraword) {
						push(
							jsx(
								"em",
								{ children: inlineNodes(emphasis[1], `${keyPrefix}em${nodes.length}-`, inLink) },
								`${keyPrefix}em${nodes.length}`
							)
						);
						index += emphasis[0].length;
						continue;
					}
				}
				if (char === "~" && text.charAt(index + 1) === "~") {
					const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(text.slice(index));
					if (strike !== null) {
						push(
							jsx(
								"del",
								{ children: inlineNodes(strike[1], `${keyPrefix}del${nodes.length}-`, inLink) },
								`${keyPrefix}del${nodes.length}`
							)
						);
						index += strike[0].length;
						continue;
					}
				}
				buffer += char;
				index += 1;
			}
			flush();
			return nodes;
		}

		/** A single list marker with its indentation and the column its content starts at. */
		function matchListItem(line) {
			const match = /^([ ]*)([-*+]|\d+[.)])([ \t]+)(.*)$/.exec(line);
			if (match === null) return undefined;
			const marker = match[2];
			return {
				indent: match[1].length,
				marker,
				ordered: /\d/.test(marker.charAt(0)),
				contentColumn: match[1].length + marker.length + Math.min(match[3].length, 4),
				content: match[4]
			};
		}

		/** Split one pipe-table row, honoring code spans and escaped pipes. */
		function splitTableRow(line) {
			const cells = [];
			let buffer = "";
			let codeRun = 0;
			for (let index = 0; index < line.length; index += 1) {
				const char = line.charAt(index);
				if (char === "\\" && line.charAt(index + 1) === "|") {
					buffer += "|";
					index += 1;
					continue;
				}
				if (char === "`") {
					const run = runLength(line, index, "`");
					codeRun = codeRun === 0 ? run : codeRun === run ? 0 : codeRun;
					buffer += "`".repeat(run);
					index += run - 1;
					continue;
				}
				if (char === "|" && codeRun === 0) {
					cells.push(buffer);
					buffer = "";
					continue;
				}
				buffer += char;
			}
			cells.push(buffer);
			if (cells.length > 0 && cells[0].trim() === "") cells.shift();
			if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
			return cells;
		}

		/** Parse a GFM table at `start`; undefined when these lines are not a table. */
		function parseTable(lines, start, key) {
			if (start + 1 >= lines.length) return undefined;
			const header = lines[start];
			if (!header.includes("|")) return undefined;
			const delimiter = lines[start + 1];
			if (!delimiter.includes("|")) return undefined;
			if (!/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/.test(delimiter)) {
				return undefined;
			}
			const headCells = splitTableRow(header);
			const delimiterCells = splitTableRow(delimiter);
			if (headCells.length === 0 || headCells.length !== delimiterCells.length) return undefined;
			const align = delimiterCells.map((cell) => {
				const value = cell.trim();
				if (value.startsWith(":") && value.endsWith(":")) return "center";
				if (value.endsWith(":")) return "right";
				if (value.startsWith(":")) return "left";
				return undefined;
			});
			let index = start + 2;
			const bodyRows = [];
			while (index < lines.length) {
				const line = lines[index];
				if (line.trim() === "" || !line.includes("|")) break;
				bodyRows.push(splitTableRow(line));
				index += 1;
			}
			const headRow = jsxs(
				"thead",
				{
					children: jsx(
						"tr",
						{
							children: headCells.map((cell, column) =>
								jsx(
									"th",
									{
										style: align[column] === undefined ? undefined : { textAlign: align[column] },
										children: inlineNodes(cell.trim(), `${key}h${column}-`)
									},
									`${key}h${column}`
								)
							)
						},
						`${key}hr`
					)
				},
				`${key}thead`
			);
			const body = jsxs(
				"tbody",
				{
					children: bodyRows.map((row, rowIndex) =>
						jsx(
							"tr",
							{
								children: headCells.map((_cell, column) =>
									jsx(
										"td",
										{
											style: align[column] === undefined ? undefined : { textAlign: align[column] },
											children: inlineNodes(String(row[column] ?? "").trim(), `${key}r${rowIndex}c${column}-`)
										},
										`${key}r${rowIndex}c${column}`
									)
								)
							},
							`${key}r${rowIndex}`
						)
					)
				},
				`${key}tbody`
			);
			return {
				next: index,
				node: jsx(
					"div",
					{
						className: "wca-table-scroll",
						children: jsxs("table", { children: [headRow, bodyRows.length > 0 ? body : null] }, `${key}table`)
					},
					key
				)
			};
		}

		/** Parse one list (nested lists arrive through recursion) starting at `start`. */
		function parseList(lines, start, key, depth) {
			const first = matchListItem(lines[start]);
			if (first === undefined) return undefined;
			const baseIndent = first.indent;
			const ordered = first.ordered;
			const startNumber = ordered ? Number.parseInt(first.marker, 10) : 1;
			const items = [];
			let index = start;
			let itemKey = 0;
			while (index < lines.length) {
				const marker = matchListItem(lines[index]);
				if (marker === undefined || marker.indent !== baseIndent || marker.ordered !== ordered) break;
				const content = [marker.content];
				let cursor = index + 1;
				while (cursor < lines.length) {
					const line = lines[cursor];
					if (line.trim() === "") {
						let lookahead = cursor + 1;
						while (lookahead < lines.length && lines[lookahead].trim() === "") lookahead += 1;
						if (lookahead >= lines.length) {
							cursor = lines.length;
							break;
						}
						const nextMarker = matchListItem(lines[lookahead]);
						if (nextMarker !== undefined && nextMarker.indent === baseIndent) {
							// A blank line between same-type items keeps one loose list instead of
							// splitting it into two lists (which would restart ordered numbering).
							if (nextMarker.ordered === ordered) cursor = lookahead;
							break;
						}
						if (indentOf(lines[lookahead]) >= marker.contentColumn) {
							content.push("");
							cursor += 1;
							continue;
						}
						break;
					}
					const nextMarker = matchListItem(line);
					if (nextMarker !== undefined && nextMarker.indent === baseIndent) break;
					const indent = indentOf(line);
					if (indent < marker.contentColumn && indent <= baseIndent) break;
					content.push(line.slice(Math.min(indent, marker.contentColumn)));
					cursor += 1;
				}
				items.push({ lines: content, key: `${key}i${itemKey}` });
				itemKey += 1;
				index = cursor;
			}
			const children = items.map((item) => {
				const blocks = renderBlocks(item.lines, `${item.key}-`, depth + 1);
				// A tight list item renders its text directly, not inside a paragraph: unwrap the
				// leading paragraph and keep any nested blocks (sublists, code, tables) after it.
				const firstBlock = blocks.length > 0 ? blocks[0] : undefined;
				const itemChildren =
					firstBlock !== undefined && firstBlock.type === "p"
						? [...firstBlock.props.children, ...blocks.slice(1)]
						: blocks;
				return jsx("li", { children: itemChildren }, item.key);
			});
			return {
				next: index,
				node: ordered
					? jsx("ol", { start: startNumber === 1 ? undefined : startNumber, children }, key)
					: jsx("ul", { children }, key)
			};
		}

		/** Render the block-level Markdown of one document (or one list item). */
		function renderBlocks(lines, keyPrefix, depth = 0) {
			// A hostile PR body can nest quotes/lists thousands deep; stop before the JavaScript stack
			// runs out and show the remaining source instead of letting a slot crash blank the panel.
			if (depth > 64) {
				return [jsx("pre", { className: "wca-md-deep", children: lines.join("\n") }, `${keyPrefix}deep`)];
			}
			const out = [];
			let index = 0;
			let blockKey = 0;
			const key = () => `${keyPrefix}b${blockKey++}`;
			while (index < lines.length) {
				const line = lines[index];
				if (line.trim() === "") {
					index += 1;
					continue;
				}
				const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
				if (fence !== null) {
					const fenceChar = fence[1].charAt(0);
					const fenceLength = fence[1].length;
					const info = fence[2].trim();
					const language = /^[A-Za-z0-9_+#.-]*/.exec(info)?.[0] ?? "";
					const openIndent = line.length - line.trimStart().length;
					const body = [];
					index += 1;
					while (index < lines.length) {
						const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[index]);
						if (closing !== null && closing[1].charAt(0) === fenceChar && closing[1].length >= fenceLength) {
							index += 1;
							break;
						}
						body.push(lines[index].slice(Math.min(openIndent, indentOf(lines[index]))));
						index += 1;
					}
					out.push(
						jsx(
							"pre",
							{
								"data-language": language === "" ? undefined : language,
								children: jsx("code", { children: body.join("\n") })
							},
							key()
						)
					);
					continue;
				}
				const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
				if (heading !== null) {
					const level = heading[1].length;
					const content = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
					const headingKey = key();
					out.push(jsx(`h${level}`, { children: inlineNodes(content, `${headingKey}-`) }, headingKey));
					index += 1;
					continue;
				}
				if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
					out.push(jsx("hr", {}, key()));
					index += 1;
					continue;
				}
				const tableKey = key();
				const table = parseTable(lines, index, tableKey);
				if (table !== undefined) {
					out.push(table.node);
					index = table.next;
					continue;
				}
				if (/^ {0,3}>/.test(line)) {
					const quoted = [];
					while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
						quoted.push(lines[index].replace(/^ {0,3}>[ \t]?/, ""));
						index += 1;
					}
					const quoteKey = key();
					out.push(
						jsx("blockquote", { children: renderBlocks(quoted, `${quoteKey}-`, depth + 1) }, quoteKey)
					);
					continue;
				}
				const listKey = key();
				const list = parseList(lines, index, listKey, depth);
				if (list !== undefined) {
					out.push(list.node);
					index = list.next;
					continue;
				}
				const paragraph = [line];
				index += 1;
				while (
					index < lines.length &&
					lines[index].trim() !== "" &&
					!BLOCK_START.test(lines[index]) &&
					!/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(lines[index])
				) {
					paragraph.push(lines[index]);
					index += 1;
				}
				const paragraphKey = key();
				out.push(jsx("p", { children: inlineNodes(paragraph.join("\n"), `${paragraphKey}-`) }, paragraphKey));
			}
			return out;
		}

		/**
		* Render a Markdown document as React elements.
		* @param text - Markdown source.
		* @returns the block elements; an empty array for empty input.
		*/
		function renderMarkdown(text) {
			const source = normalizeSource(text);
			if (source.trim() === "") return [];
			try {
				return renderBlocks(source.split("\n"), "");
			} catch (error) {
				// Never let an externally supplied body throw past the component: a slot crash blanks
				// the whole main page. Degrade to the raw source instead.
				return [jsx("pre", { className: "wca-md-deep", children: source }, "markdown-fallback")];
			}
		}

		/** Memoized Markdown body; parsing only happens once per distinct PR body. */
		function Markdown(props) {
			const blocks = react.useMemo(() => renderMarkdown(props.text), [props.text]);
			return jsx("div", { className: "wca-md", children: blocks });
		}
		//#endregion

		//#region styles
		//
		// Styling follows the host: the page uses the Plugin Manager page's padding and
		// max-width rhythm, and controls copy the primitive CSS (Button, Tag,
		// SegmentedTabs, DisclosureRow) with a `wca-` prefix so no host class is
		// reused. Every color comes from a `--dsw-alias-*` token; no literal color is
		// hardcoded, so light and dark themes are both the host's call.
		const STYLES = `
			.wca-page {
				box-sizing: border-box;
				height: 100%;
				min-height: 100%;
				display: flex;
				flex-direction: column;
				align-items: center;
				gap: 24px;
				padding: 0 clamp(24px, 4vw, 48px) 48px;
				overflow: auto;
				color: var(--dsw-alias-label-primary);
			}
			.wca-page > * { width: 100%; max-width: 960px; }
			.wca-head {
				box-sizing: border-box;
				display: flex;
				align-items: flex-start;
				justify-content: space-between;
				gap: 16px;
				padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px));
			}
			.wca-title {
				margin: 0;
				font-size: 20px;
				font-weight: 500;
				line-height: 28px;
			}
			.wca-subtitle {
				margin: 4px 0 0;
				color: var(--dsw-alias-label-secondary);
				font-size: 13px;
				line-height: 20px;
			}
			.wca-nav {
				display: flex;
				align-items: center;
				gap: 12px;
				width: 100%;
				min-width: 0;
			}
			.wca-nav-label {
				flex: none;
				color: var(--dsw-alias-label-tertiary);
				font-size: 12px;
				line-height: 18px;
				font-weight: 600;
				letter-spacing: .02em;
			}
			.wca-tabs {
				display: flex;
				gap: 4px;
				width: fit-content;
				min-width: 0;
				overflow-x: auto;
				padding: 4px;
				border-radius: var(--dsw-radius-lg);
				background: var(--dsw-alias-bg-module-platform);
			}
			.wca-tab {
				height: 34px;
				padding: 0 12px;
				border: 0;
				border-radius: var(--dsw-radius-md);
				background: transparent;
				color: var(--dsw-alias-label-secondary);
				font: inherit;
				font-size: 14px;
				line-height: 20px;
				cursor: pointer;
				white-space: nowrap;
			}
			.wca-tab:hover { color: var(--dsw-alias-label-primary); }
			.wca-tab[aria-selected="true"] {
				border: .5px solid var(--dsw-alias-border-l3);
				background: var(--dsw-alias-bg-layer-3);
				color: var(--dsw-alias-label-primary);
				font-weight: 600;
			}
			.wca-tab:focus-visible,
			.wca-segment:focus-visible,
			.wca-btn:focus-visible,
			.wca-disclosure-toggle:focus-visible,
			.wca-comment:focus-visible,
			.wca-open:focus-visible {
				outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
				outline-offset: 2px;
			}
			.wca-feature {
				box-sizing: border-box;
				min-width: 0;
				overflow: hidden;
				border: .5px solid var(--dsw-alias-border-l2);
				border-radius: var(--dsw-radius-xl);
				background: var(--dsw-alias-bg-layer-1);
			}
			.wca-feature-head {
				box-sizing: border-box;
				display: flex;
				align-items: flex-start;
				justify-content: space-between;
				gap: 16px;
				padding: 16px;
				border-bottom: .5px solid var(--dsw-alias-border-l2);
				flex-wrap: wrap;
			}
			.wca-feature-heading {
				display: flex;
				flex-direction: column;
				gap: 2px;
				min-width: 0;
			}
			.wca-feature-title {
				margin: 0;
				font-size: 16px;
				font-weight: 500;
				line-height: 24px;
			}
			.wca-feature-desc {
				margin: 0;
				color: var(--dsw-alias-label-tertiary);
				font-size: 13px;
				line-height: 20px;
			}
			.wca-toolbar {
				display: flex;
				align-items: center;
				justify-content: flex-end;
				gap: 12px;
				flex-wrap: wrap;
			}
			.wca-segmented {
				display: flex;
				align-items: center;
				gap: 2px;
				padding: 2px;
				border-radius: var(--dsw-radius-md);
				background: var(--dsw-alias-interactive-bg-hover);
			}
			.wca-segment {
				box-sizing: border-box;
				display: inline-flex;
				align-items: center;
				gap: 6px;
				height: 26px;
				padding: 0 9px;
				border: .5px solid transparent;
				border-radius: var(--dsw-radius-sm);
				background: transparent;
				color: var(--dsw-alias-label-secondary);
				font: inherit;
				font-size: 12px;
				line-height: 18px;
				cursor: pointer;
				white-space: nowrap;
			}
			.wca-segment:hover { color: var(--dsw-alias-label-primary); }
			.wca-segment[aria-pressed="true"] {
				border-color: var(--dsw-alias-border-l3);
				background: var(--dsw-alias-bg-layer-1);
				color: var(--dsw-alias-label-primary);
				font-weight: 500;
			}
			.wca-segment-count {
				color: var(--dsw-alias-label-tertiary);
				font-size: 11px;
				line-height: 16px;
				font-variant-numeric: tabular-nums;
			}
			.wca-feature-body {
				display: flex;
				flex-direction: column;
				min-width: 0;
				padding: 4px 16px 8px;
			}
			.wca-status {
				margin: 12px 0 0;
				min-height: 20px;
				color: var(--dsw-alias-label-tertiary);
				font-size: 13px;
				line-height: 20px;
			}
			.wca-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
			.wca-items { display: flex; flex-direction: column; min-width: 0; }
			.wca-item {
				display: flex;
				flex-direction: column;
				gap: 10px;
				min-width: 0;
				padding: 16px 0;
				border-top: .5px solid var(--dsw-alias-border-l2);
			}
			.wca-item:first-child { border-top: 0; }
			.wca-item-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
			.wca-repo { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
			.wca-repo strong { color: var(--dsw-alias-label-primary); font-weight: 500; }
			.wca-item-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
			.wca-meta { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
			.wca-diff {
				font: var(--dsw-font-markdown-code-block-small);
				font-variant-numeric: tabular-nums;
			}
			.wca-added { color: var(--dsw-alias-state-success-primary); }
			.wca-removed { color: var(--dsw-alias-state-error-primary); }
			.wca-item[data-status="approved"] .wca-item-title {
				color: var(--dsw-alias-label-secondary);
				font-weight: 500;
			}
			.wca-item[data-status="approved"] .wca-repo strong { color: var(--dsw-alias-label-secondary); }
			.wca-tag {
				display: inline-flex;
				align-items: center;
				border-radius: 999px;
				padding: 1px 8px;
				font-size: 11px;
				line-height: 17px;
				font-weight: 500;
				white-space: nowrap;
			}
			.wca-tag[data-tone="success"] {
				background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
				color: var(--dsw-alias-state-success-primary);
			}
			.wca-tag[data-tone="info"] {
				background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
				color: var(--dsw-alias-state-business-primary);
			}
			.wca-tag[data-tone="warning"] {
				background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
				color: var(--dsw-alias-state-warn-primary);
			}
			.wca-tag[data-tone="danger"] {
				background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
				color: var(--dsw-alias-state-error-primary);
			}
			.wca-tag[data-tone="neutral"] {
				background: var(--dsw-alias-bg-module-platform);
				color: var(--dsw-alias-label-secondary);
			}
			.wca-tag[data-tone="pending"] {
				background: var(--dsw-alias-bg-module-platform);
				color: var(--dsw-alias-label-tertiary);
			}
			.wca-btn {
				box-sizing: border-box;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				gap: 4px;
				height: 28px;
				padding: 0 10px;
				border: 0;
				border-radius: var(--dsw-radius-sm);
				background: transparent;
				color: var(--dsw-alias-label-primary);
				font: inherit;
				font-size: 12px;
				line-height: 18px;
				cursor: pointer;
			}
			.wca-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
			.wca-btn:disabled { opacity: .4; cursor: not-allowed; }
			.wca-btn[data-variant="primary"] {
				background: var(--dsw-alias-button-primary-fill);
				color: var(--dsw-alias-label-primary-foreground);
			}
			.wca-btn[data-variant="primary"]:hover:not(:disabled) {
				background: var(--dsw-alias-button-primary-hover);
			}
			.wca-btn[data-variant="outline"] { border: .5px solid var(--dsw-alias-border-l3); }
			.wca-disclosure {
				display: flex;
				flex-direction: column;
				gap: 8px;
				padding-top: 10px;
				border-top: .5px solid var(--dsw-alias-border-l2);
			}
			.wca-disclosure-toggle {
				display: inline-flex;
				align-items: center;
				gap: 6px;
				width: fit-content;
				padding: 2px 0;
				border: 0;
				background: none;
				color: var(--dsw-alias-label-secondary);
				font: inherit;
				font-size: 13px;
				line-height: 20px;
				cursor: pointer;
			}
			.wca-disclosure-toggle:hover { color: var(--dsw-alias-label-primary); }
			.wca-chevron { flex: none; transition: transform .12s ease; }
			.wca-chevron[data-open="true"] { transform: rotate(90deg); }
			@media (prefers-reduced-motion: reduce) { .wca-chevron { transition: none; } }
			.wca-reviews {
				display: flex;
				flex-direction: column;
				gap: 8px;
				padding-top: 10px;
				border-top: .5px solid var(--dsw-alias-border-l2);
			}
			.wca-reviews-title { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
			.wca-review {
				padding: 8px 10px;
				border-left: 3px solid var(--dsw-alias-border-l2);
				border-radius: 0 var(--dsw-radius-sm) var(--dsw-radius-sm) 0;
				background: var(--dsw-alias-bg-module-platform);
			}
			.wca-review-head { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; }
			.wca-review-time { color: var(--dsw-alias-label-tertiary); }
			.wca-review-text {
				margin: 2px 0 0;
				white-space: pre-wrap;
				overflow-wrap: anywhere;
				font-size: var(--dsh-content-font-size-secondary, 13px);
				line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
			}
			.wca-form {
				display: flex;
				flex-direction: column;
				gap: 8px;
				padding-top: 10px;
				border-top: .5px solid var(--dsw-alias-border-l2);
			}
			.wca-issue-box {
				display: flex;
				flex-direction: column;
				gap: 8px;
				padding: 10px;
				border: .5px solid var(--dsw-alias-border-l2);
				border-radius: var(--dsw-radius-md);
				background: var(--dsw-alias-bg-module-platform);
			}
			.wca-comment {
				box-sizing: border-box;
				width: 100%;
				min-height: 64px;
				resize: vertical;
				padding: 8px 10px;
				border: .5px solid var(--dsw-alias-border-l4);
				border-radius: var(--dsw-radius-sm);
				background: var(--dsw-alias-bg-base);
				color: var(--dsw-alias-label-primary);
				font: inherit;
				font-size: 13px;
				line-height: 20px;
			}
			.wca-comment::placeholder { color: var(--dsw-alias-label-dimmed); }
			.wca-actions { display: flex; gap: 8px; flex-wrap: wrap; }
			.wca-form-error {
				margin: 0;
				min-height: 18px;
				color: var(--dsw-alias-state-error-primary);
				font-size: 12px;
				line-height: 18px;
			}
			.wca-open {
				width: fit-content;
				color: var(--dsw-alias-link);
				font-size: 13px;
				line-height: 20px;
				text-decoration: none;
			}
			.wca-open:hover { text-decoration: underline; }
			.wca-empty { margin: 16px 0 8px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }

			/* Markdown body: type, spacing and code surfaces follow the host Markdown. */
			.wca-md {
				min-width: 0;
				overflow-wrap: anywhere;
				font: var(--dsw-font-markdown-base);
				color: var(--dsw-alias-label-primary);
			}
			.wca-md > :first-child { margin-top: 0; }
			.wca-md > :last-child { margin-bottom: 0; }
			.wca-md strong { font-weight: 600; }
			.wca-md h1 { font: var(--dsw-font-markdown-h1); margin: 24px 0 12px; }
			.wca-md h2 { font: var(--dsw-font-markdown-h2); margin: 22px 0 10px; }
			.wca-md h3 { font: var(--dsw-font-markdown-h3); margin: 20px 0 8px; }
			.wca-md h4 { font: var(--dsw-font-markdown-h4); margin: 16px 0 6px; }
			.wca-md :is(h5, h6) { font: var(--dsw-font-markdown-base-strong); margin: 14px 0 6px; }
			.wca-md p { margin: 12px 0; }
			.wca-md :where(ul, ol) { margin: 12px 0; padding-left: 22px; }
			.wca-md li:not(:first-child) { margin-top: 4px; }
			.wca-md li::marker { color: var(--dsw-alias-label-secondary); }
			.wca-md li > :where(ul, ol) { margin-top: 4px; }
			.wca-md a { color: var(--dsw-alias-link); font-weight: 500; text-decoration: none; }
			.wca-md a:hover { text-decoration: underline; text-underline-offset: 3px; }
			.wca-md :not(pre) > code {
				font: var(--dsw-font-markdown-code);
				font-size: .875em;
				background: var(--dsw-alias-markdown-inline-code);
				border: .5px solid var(--dsw-alias-border-l1);
				border-radius: var(--dsw-radius-sm);
				padding: 0 5px;
			}
			.wca-md pre {
				margin: 12px 0;
				padding: 12px 14px;
				overflow: auto;
				border: .5px solid var(--dsw-alias-border-l1);
				border-radius: var(--dsw-radius-lg);
				background: var(--dsw-alias-markdown-code-block);
				color: var(--dsw-alias-label-primary);
				font: var(--dsw-font-markdown-code-block-small);
			}
			.wca-md pre code { font: inherit; background: none; border: 0; padding: 0; }
			.wca-md blockquote {
				margin: 12px 0;
				padding-left: 14px;
				border-left: 2px solid var(--dsw-alias-label-caption);
				color: var(--dsw-alias-label-secondary);
			}
			.wca-md hr { height: .5px; margin: 20px 0; border: 0; background: var(--dsw-alias-border-l2); }
			.wca-md .wca-table-scroll { max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; }
			.wca-md table { border-collapse: collapse; width: max-content; max-width: 100%; }
			.wca-md th,
			.wca-md td {
				max-width: min(30vw, 320px);
				padding: 8px 12px;
				border: .5px solid var(--dsw-alias-border-l2);
				text-align: start;
				vertical-align: top;
				overflow-wrap: anywhere;
			}
			.wca-md th {
				background: var(--dsw-alias-bg-module-platform);
				font: var(--dsw-font-markdown-table-head);
			}
			.wca-md td { font: var(--dsw-font-markdown-table); }
		`;
		//#endregion

		//#region data + components

		/** Format one timestamp for the review list. */
		function formatTime(value) {
			const date = new Date(String(value ?? ""));
			if (Number.isNaN(date.getTime())) return String(value ?? "");
			return date.toLocaleString(undefined, { hour12: false });
		}

		/**
		* Normalize one review kind for display. Old records used `question`/`fix`; both mean
		* "this PR has a problem". The disk record is never rewritten — only the view normalizes.
		* @param review - stored review entry.
		* @returns `"approve"` or `"issue"`.
		*/
		function reviewKindOf(review) {
			return String(review?.kind ?? "").trim().toLowerCase() === "approve" ? "approve" : "issue";
		}

		/**
		* Derive an item's review status from its latest review entry; there is no stored status
		* field, so the log stays the single source of truth.
		* @param item - inbox item.
		* @returns `"pending"`, `"approved"` or `"issue"`.
		*/
		function statusOf(item) {
			const reviews = Array.isArray(item?.review) ? item.review : [];
			if (reviews.length === 0) return "pending";
			return reviewKindOf(reviews[reviews.length - 1]) === "approve" ? "approved" : "issue";
		}

		/** Map a derived status to a Tag tone. */
		function statusTone(status) {
			switch (status) {
				case "approved":
					return "success";
				case "issue":
					return "danger";
				default:
					return "pending";
			}
		}

		/** The derived status badge shown at the top of every item. */
		function StatusBadge(props) {
			return jsx(
				"span",
				{
					className: "wca-tag",
					"data-tone": statusTone(props.status),
					children: props.t(`status.${props.status}`)
				},
				"status"
			);
		}

		/** Map an item's GitHub state to a neutral Tag tone (context only, not review status). */
		function stateTone(state) {
			switch (String(state ?? "").toUpperCase()) {
				case "OPEN":
					return "info";
				case "MERGED":
					return "success";
				case "CLOSED":
					return "danger";
				default:
					return "neutral";
			}
		}

		/** The localized label of one PR state, falling back to the raw state. */
		function stateLabel(t, state) {
			if (state === "") return "";
			const key = `state.${state.toLowerCase()}`;
			const label = t(key);
			return label === key ? state : label;
		}

		/** Render one review entry (kind badge, time, and the issue text when present). */
		function ReviewRow(props) {
			const review = props.review;
			const kind = reviewKindOf(review);
			const text = String(review?.text ?? "");
			return jsxs(
				"div",
				{
					className: "wca-review",
					children: [
						jsxs(
							"div",
							{
								className: "wca-review-head",
								children: [
									jsx(
										"span",
										{
											className: "wca-tag",
											"data-tone": kind === "approve" ? "success" : "danger",
											children: props.t(kind === "approve" ? "status.approved" : "status.issue")
										},
										"kind"
									),
									jsx("span", { className: "wca-review-time", children: formatTime(review?.at) }, "time")
								]
							},
							"head"
						),
						text === "" ? null : jsx("p", { className: "wca-review-text", children: text }, "text")
					]
				},
				String(review?.at ?? "") + kind
			);
		}

		/**
		* The review actions: Approve submits directly; Flag issue reveals the comment box and
		* dispatches only after text is submitted.
		*/
		function ReviewForm(props) {
			const t = props.t;
			const [open, setOpen] = react.useState(false);
			const [text, setText] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");
			const mounted = react.useRef(true);
			const textarea = react.useRef(null);
			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			react.useEffect(() => {
				if (open && textarea.current !== null) textarea.current.focus();
			}, [open]);
			const submit = async (kind) => {
				const value = kind === "issue" ? text.trim() : "";
				if (kind === "issue" && value === "") {
					setError(t("form.issueEmpty"));
					if (textarea.current !== null) textarea.current.focus();
					return;
				}
				setBusy(true);
				setError("");
				try {
					const response = await fetch(REVIEW_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: props.item.id, kind, text: value })
					});
					const payload = await response.json().catch(() => ({}));
					if (!response.ok || payload.ok !== true) {
						throw new Error(payload?.message ?? `HTTP ${response.status}`);
					}
					if (!mounted.current) return;
					setText("");
					setOpen(false);
					props.onSubmitted();
				} catch (failure) {
					if (!mounted.current) return;
					setError(t("form.failed", { message: failure instanceof Error ? failure.message : String(failure) }));
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			return jsxs(
				"div",
				{
					className: "wca-form",
					children: [
						jsxs(
							"div",
							{
								className: "wca-actions",
								children: [
									jsx(
										"button",
										{
											type: "button",
											className: "wca-btn",
											"data-variant": "outline",
											disabled: busy || props.status === "approved",
											onClick: () => submit("approve"),
											children: busy ? t("form.inflight") : t("form.pass")
										},
										"approve"
									),
									jsx(
										"button",
										{
											type: "button",
											className: "wca-btn",
											"data-variant": "primary",
											disabled: busy,
											"aria-expanded": open,
											onClick: () => {
												setError("");
												setOpen(true);
											},
											children: t("form.issue")
										},
										"issue"
									)
								]
							},
							"actions"
						),
						open
							? jsxs(
									"div",
									{
										className: "wca-issue-box",
										children: [
											jsx("textarea", {
												ref: textarea,
												className: "wca-comment",
												rows: 3,
												placeholder: t("form.issuePlaceholder"),
												"aria-label": t("form.issuePlaceholder"),
												value: text,
												disabled: busy,
												onChange: (event) => {
													setText(event.target.value);
													if (error !== "") setError("");
												}
											}),
											jsxs(
												"div",
												{
													className: "wca-actions",
													children: [
														jsx(
															"button",
															{
																type: "button",
																className: "wca-btn",
																"data-variant": "primary",
																disabled: busy,
																onClick: () => submit("issue"),
																children: busy ? t("form.inflight") : t("form.submit")
															},
															"submit"
														),
														jsx(
															"button",
															{
																type: "button",
																className: "wca-btn",
																"data-variant": "outline",
																disabled: busy,
																onClick: () => {
																	setOpen(false);
																	setError("");
																},
																children: t("form.cancel")
															},
															"cancel"
														)
													]
												},
												"box-actions"
											)
										]
									},
									"box"
							  )
							: null,
						jsx("p", { className: "wca-form-error", role: "alert", children: error }, "error")
					]
				},
				"form"
			);
		}

		/** The collapsed-by-default PR description disclosure with the rendered Markdown body. */
		function BodyDisclosure(props) {
			const t = props.t;
			const [open, setOpen] = react.useState(false);
			const hasBody = typeof props.text === "string" && props.text.trim() !== "";
			return jsxs(
				"div",
				{
					className: "wca-disclosure",
					children: [
						jsxs(
							"button",
							{
								type: "button",
								className: "wca-disclosure-toggle",
								"aria-expanded": open,
								onClick: () => setOpen((value) => !value),
								children: [jsx(ChevronIcon, { open }, "chevron"), jsx("span", { children: t("card.body") }, "label")]
							},
							"toggle"
						),
						open ? jsx(Markdown, { text: hasBody ? props.text : t("card.bodyEmpty") }, "body") : null
					]
				},
				"disclosure"
			);
		}

		/** One PR row inside the inbox feature panel. */
		function PrItem(props) {
			const item = props.item;
			const t = props.t;
			const reviews = Array.isArray(item.review) ? item.review : [];
			const status = statusOf(item);
			const href = safeWebHref(item.url);
			const additions = Number.isFinite(Number(item.additions)) ? Number(item.additions) : 0;
			const deletions = Number.isFinite(Number(item.deletions)) ? Number(item.deletions) : 0;
			const files = Number.isFinite(Number(item.changedFiles)) ? Number(item.changedFiles) : 0;
			return jsxs(
				"article",
				{
					className: "wca-item",
					"data-status": status,
					children: [
						jsxs(
							"div",
							{
								className: "wca-item-head",
								children: [
									jsxs(
										"div",
										{
											className: "wca-repo",
											children: [jsx("strong", { children: String(item.repo ?? "") }), ` #${String(item.pr ?? "")}`]
										},
										"repo"
									),
									jsx(StatusBadge, { status, t }, "status")
								]
							},
							"head"
						),
						jsx("h3", { className: "wca-item-title", children: String(item.title ?? "") || t("card.untitled") }, "title"),
						jsxs(
							"p",
							{
								className: "wca-meta",
								children: [
									jsx("span", { className: "wca-diff wca-added", children: `+${additions}` }, "add"),
									" ",
									jsx("span", { className: "wca-diff wca-removed", children: `−${deletions}` }, "del"),
									" ",
									jsx("span", { children: t("card.files", { count: files }) }, "files")
								]
							},
							"meta"
						),
						jsx(BodyDisclosure, { text: item.body, t }, "body"),
						reviews.length === 0
							? null
							: jsxs(
									"div",
									{
										className: "wca-reviews",
										children: [
											jsx("div", { className: "wca-reviews-title", children: t("card.reviews", { count: reviews.length }) }, "title"),
											reviews.map((review, index) => jsx(ReviewRow, { review, t }, `review-${index}`))
										]
									},
									"reviews"
							  ),
						jsx(ReviewForm, { item, t, status, onSubmitted: props.onSubmitted }, "form"),
						href === undefined
							? null
							: jsx(
									"a",
									{
										className: "wca-open",
										href,
										target: "_blank",
										rel: "noopener noreferrer",
										children: t("card.open")
									},
									"open"
							  )
					]
				},
				String(item.id ?? item.pr ?? "")
			);
		}

		/** The four inbox filters; the default view is pending. */
		const FILTERS = [
			{ id: "all", labelKey: "filter.all" },
			{ id: "pending", labelKey: "filter.pending" },
			{ id: "issue", labelKey: "filter.issue" },
			{ id: "approved", labelKey: "filter.approved" }
		];

		/**
		* The inbox feature panel: feature header and toolbar, a derived-status filter, and the
		* PR rows. It owns its own controls so a future feature does not inherit them.
		*/
		function InboxSection(props) {
			const t = props.t;
			const feature = props.feature;
			const [items, setItems] = react.useState(null);
			const [loading, setLoading] = react.useState(true);
			const [error, setError] = react.useState("");
			const [updatedAt, setUpdatedAt] = react.useState(null);
			const [filter, setFilter] = react.useState("pending");
			const alive = react.useRef(true);
			const inflight = react.useRef(null);
			const rerun = react.useRef(false);
			const load = react.useCallback(() => {
				if (inflight.current !== null) {
					rerun.current = true;
					return inflight.current;
				}
				setLoading(true);
				const request = (async () => {
					try {
						const response = await fetch(ITEMS_URL, { headers: { accept: "application/json" }, cache: "no-store" });
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const payload = await response.json();
						if (!alive.current) return;
						setItems(Array.isArray(payload.items) ? payload.items : []);
						setUpdatedAt(new Date());
						setError("");
					} catch (failure) {
						if (!alive.current) return;
						setError(t("status.failed", { message: failure instanceof Error ? failure.message : String(failure) }));
					} finally {
						if (alive.current) setLoading(false);
					}
				})();
				inflight.current = request;
				request.finally(() => {
					if (inflight.current === request) inflight.current = null;
					if (rerun.current) {
						rerun.current = false;
						load();
					}
				});
				return request;
			}, [t]);
			react.useEffect(() => {
				alive.current = true;
				load();
				return () => {
					alive.current = false;
				};
			}, [load]);
			const counts = react.useMemo(() => {
				const next = { all: 0, pending: 0, issue: 0, approved: 0 };
				for (const item of items ?? []) {
					next.all += 1;
					next[statusOf(item)] += 1;
				}
				return next;
			}, [items]);
			const visible = react.useMemo(() => {
				const list = items ?? [];
				return filter === "all" ? list : list.filter((item) => statusOf(item) === filter);
			}, [items, filter]);
			const status =
				error !== ""
					? error
					: loading || items === null
						? t("status.loading")
						: t("status.loaded", {
								count: items.length,
								time: updatedAt === null ? "" : updatedAt.toLocaleTimeString(undefined, { hour12: false })
							});
			const titleId = `wca-feature-${feature.id}`;
			return jsxs(
				"section",
				{
					className: "wca-feature",
					"aria-labelledby": titleId,
					children: [
						jsxs(
							"header",
							{
								className: "wca-feature-head",
								children: [
									jsxs(
										"div",
										{
											className: "wca-feature-heading",
											children: [
												jsx("h2", { id: titleId, className: "wca-feature-title", children: t(feature.titleKey) }, "title"),
												jsx("p", { className: "wca-feature-desc", children: t(feature.descriptionKey) }, "desc")
											]
										},
										"heading"
									),
									jsxs(
										"div",
										{
											className: "wca-toolbar",
											children: [
												jsx(
													"div",
													{
														className: "wca-segmented",
														role: "group",
														"aria-label": t("filter.label"),
														children: FILTERS.map((option) =>
															jsx(
																"button",
																{
																	type: "button",
																	className: "wca-segment",
																	"aria-pressed": filter === option.id,
																	onClick: () => setFilter(option.id),
																	children: [
																		t(option.labelKey),
																		jsx("span", { className: "wca-segment-count", children: counts[option.id] }, "count")
																	]
																},
																option.id
															)
														)
													},
													"filters"
												),
												jsx(
													"button",
													{
														type: "button",
														className: "wca-btn",
														"data-variant": "outline",
														disabled: loading,
														onClick: () => load(),
														children: t("refresh")
													},
													"refresh"
												)
											]
										},
										"toolbar"
									)
								]
							},
							"head"
						),
						jsxs(
							"div",
							{
								className: "wca-feature-body",
								children: [
									jsx(
										"p",
										{
											className: "wca-status",
											"data-tone": error !== "" ? "error" : undefined,
											role: error !== "" ? "alert" : undefined,
											children: status
										},
										"status"
									),
									items !== null && items.length === 0
										? jsx("p", { className: "wca-empty", children: t("inbox.empty") }, "empty")
										: null,
									items !== null && items.length > 0 && visible.length === 0
										? jsx("p", { className: "wca-empty", children: t("filter.empty") }, "filtered-empty")
										: null,
									items !== null && visible.length > 0
										? jsx(
												"div",
												{
													className: "wca-items",
													children: visible.map((item, index) =>
														jsx(PrItem, { item, t, onSubmitted: () => load() }, String(item.id ?? index))
													)
												},
												"items"
										  )
										: null
								]
							},
							"body"
						)
					]
				},
				"feature"
			);
		}

		/**
		* The features this page hosts. Adding a feature is exactly one array entry plus its
		* component; the feature nav and the active body are generated from this list.
		*/
		const SECTIONS = [
			{
				id: "inbox",
				labelKey: "section.inbox",
				titleKey: "feature.inbox.title",
				descriptionKey: "feature.inbox.description",
				Component: InboxSection
			}
		];

		/** The `main` slot page: title, feature navigation, and the active feature panel. */
		function PanelPage(props) {
			const t = props.t;
			const [active, setActive] = react.useState(SECTIONS[0].id);
			const section = SECTIONS.find((candidate) => candidate.id === active) ?? SECTIONS[0];
			const Component = section.Component;
			return jsxs(
				"div",
				{
					className: "wca-page",
					children: [
						jsx("style", { children: STYLES }, "style"),
						jsxs(
							"header",
							{
								className: "wca-head",
								children: [
									jsxs(
										"div",
										{
											children: [
												jsx("h1", { className: "wca-title", children: t("panel") }, "title"),
												jsx("p", { className: "wca-subtitle", children: t("panel.subtitle") }, "subtitle")
											]
										},
										"heading"
									)
								]
							},
							"head"
						),
						jsxs(
							"nav",
							{
								className: "wca-nav",
								children: [
									jsx("span", { className: "wca-nav-label", children: t("nav.features") }, "label"),
									jsx(
										"div",
										{
											className: "wca-tabs",
											role: "tablist",
											"aria-label": t("sections.label"),
											children: SECTIONS.map((candidate) =>
												jsx(
													"button",
													{
														type: "button",
														role: "tab",
														id: `wca-tab-${candidate.id}`,
														"aria-controls": `wca-panel-${candidate.id}`,
														className: "wca-tab",
														"aria-selected": candidate.id === section.id,
														onClick: () => setActive(candidate.id),
														children: t(candidate.labelKey)
													},
													candidate.id
												)
											)
										},
										"tabs"
									)
								]
							},
							"nav"
						),
						jsx(
							"div",
							{
								id: `wca-panel-${section.id}`,
								role: "tabpanel",
								"aria-labelledby": `wca-tab-${section.id}`,
								children: jsx(Component, { t, feature: section })
							},
							"section"
						)
					]
				},
				"page"
			);
		}
		//#endregion

		const inject = ["slots", "locale"];
		/**
		* Fill the sidebar panel list and the main page with the review inbox.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "wheelchair-agent-webui: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 10,
				locale: NS,
				label: () => t("panel")
			}, InboxIcon));
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({
					t
				})
			}, PanelPage));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
