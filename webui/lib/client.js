window.__ModuleLoader__.load({
	id: "wheelchair-agent-webui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		/** Namespace of this package's locale dictionaries and slot declarations. */
		const NS = "wheelchair-agent-webui";
		/**
		* Id of the wheelchair-agent UI home panel. It is shared by the sidebar row
		* and the `main` page registration, and it is the same in both languages: the
		* panel is the product entry, whose first section is the review inbox.
		*/
		const PANEL_ID = "wheelchair-agent";
		const zh = {
			panel: "wheelchair-agent"
		};
		const en = {
			panel: "wheelchair-agent"
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
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [(0, react_jsx_runtime.jsx)("path", {
					d: "M2 9.5h3l1 1.8h4l1-1.8h3"
				}, "tray"), (0, react_jsx_runtime.jsx)("path", {
					d: "M2.8 9.5V4.2A1.2 1.2 0 0 1 4 3h8a1.2 1.2 0 0 1 1.2 1.2v5.3"
				}, "top"), (0, react_jsx_runtime.jsx)("path", {
					d: "M2.8 9.5v2.3A1.2 1.2 0 0 0 4 13h8a1.2 1.2 0 0 0 1.2-1.2V9.5"
				}, "bottom")]
			});
		}
		/**
		* The panel page: one full-size iframe onto the standalone page, which is the
		* wheelchair-agent UI home and hosts its sections (the review inbox is the
		* first one). The iframe makes the standalone server and the dsh panel share
		* exactly one UI implementation, and its document-relative `src` resolves
		* against the panel's own URL.
		* @param props - slot-injected `t` from this namespace.
		* @returns the page frame.
		*/
		function InboxPage(props) {
			const t = props && typeof props.t === "function" ? props.t : (key) => key;
			return (0, react_jsx_runtime.jsx)("iframe", {
				src: "wheelchair-inbox/page",
				title: t("panel"),
				style: {
					border: "0",
					width: "100%",
					height: "100%",
					minHeight: "100vh",
					display: "block"
				}
			});
		}
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
			}, InboxPage));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
