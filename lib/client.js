window.__ModuleLoader__.load({
	id: "@dsh-extra/dsh-remote",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/RemoteTab.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
async function api(path, init) {
  const hasBody = init?.body !== void 0;
  const req = hasBody ? { method: init?.method ?? "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init?.body) } : { method: init?.method ?? "GET" };
  const res = await fetch(path, req);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return await res.json();
}
var c = {
  text: "var(--dsw-alias-label-primary, #1f2329)",
  textSecondary: "var(--dsw-alias-label-secondary, #4e5969)",
  bgLayer: "var(--dsw-alias-bg-layer-1, #f7f8fa)",
  border: "var(--dsw-alias-separator-primary, #e5e6eb)",
  accent: "var(--dsw-alias-state-business-primary, #3370ff)",
  danger: "var(--dsw-alias-state-danger-primary, #f53f3f)",
  success: "var(--dsw-alias-state-success-primary, #00b42a)"
};
var s = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
    color: c.text,
    fontSize: 13,
    lineHeight: 1.6
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 14,
    borderRadius: 8,
    background: c.bgLayer,
    border: `1px solid ${c.border}`
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    margin: 0
  },
  desc: { color: c.textSecondary, margin: 0 },
  row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  input: {
    padding: "4px 8px",
    borderRadius: 6,
    border: `1px solid ${c.border}`,
    background: "var(--dsw-alias-bg-base, #fff)",
    color: c.text,
    fontSize: 13
  },
  button: {
    padding: "4px 12px",
    borderRadius: 6,
    border: `1px solid ${c.border}`,
    background: "var(--dsw-alias-bg-base, #fff)",
    color: c.text,
    fontSize: 13,
    cursor: "pointer"
  },
  primaryButton: {
    padding: "4px 12px",
    borderRadius: 6,
    border: "none",
    background: c.accent,
    color: "#fff",
    fontSize: 13,
    cursor: "pointer"
  },
  code: {
    fontFamily: "monospace",
    fontSize: 12,
    padding: "2px 6px",
    background: "var(--dsw-alias-bg-base, #fff)",
    borderRadius: 4,
    border: `1px solid ${c.border}`,
    wordBreak: "break-all"
  },
  badge: {
    fontSize: 11,
    padding: "1px 6px",
    borderRadius: 4,
    background: c.border,
    color: c.textSecondary
  },
  hint: { fontSize: 12, color: c.textSecondary, margin: 0 },
  log: {
    fontFamily: "monospace",
    fontSize: 11,
    color: c.textSecondary,
    maxHeight: 140,
    overflowY: "auto",
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all"
  }
};
function RemoteTab({ t }) {
  const [status, setStatus] = (0, import_react.useState)(null);
  const [loadError, setLoadError] = (0, import_react.useState)("");
  const [enabledDraft, setEnabledDraft] = (0, import_react.useState)(false);
  const [portDraft, setPortDraft] = (0, import_react.useState)("");
  const [bindDraft, setBindDraft] = (0, import_react.useState)("");
  const [links, setLinks] = (0, import_react.useState)(null);
  const [copiedUrl, setCopiedUrl] = (0, import_react.useState)("");
  const copiedTimer = (0, import_react.useRef)(void 0);
  const refresh = (0, import_react.useCallback)(async () => {
    try {
      const st = await api("/dsh-remote/api/status");
      setStatus(st);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  (0, import_react.useEffect)(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5e3);
    return () => {
      clearInterval(timer);
      if (copiedTimer.current !== void 0) clearTimeout(copiedTimer.current);
    };
  }, [refresh]);
  (0, import_react.useEffect)(() => {
    if (status === null) return;
    setEnabledDraft(status.enabled);
    setPortDraft(String(status.port));
    setBindDraft(status.bind);
  }, [status]);
  const genLink = (0, import_react.useCallback)(async () => {
    try {
      const res = await api("/dsh-remote/api/pairing", { body: {} });
      setLinks(res.links);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const copy = (0, import_react.useCallback)(async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      if (copiedTimer.current !== void 0) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedUrl(""), 1500);
    } catch {
    }
  }, []);
  const rename = (0, import_react.useCallback)(async (id) => {
    const name = window.prompt(t("rename"));
    if (name === null || name.trim() === "") return;
    try {
      await api("/dsh-remote/api/devices/rename", { body: { id, name: name.trim() } });
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [refresh, t]);
  const revoke = (0, import_react.useCallback)(async (id) => {
    if (!window.confirm(t("revokeConfirm"))) return;
    try {
      await api("/dsh-remote/api/devices/revoke", { body: { id } });
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [refresh, t]);
  const listening = status?.listening ?? false;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.root, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: { ...s.sectionTitle, fontSize: 15 }, children: t("title") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: s.desc, children: t("desc") }),
    loadError !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...s.hint, color: c.danger }, children: loadError }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.section, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { style: s.sectionTitle, children: t("status") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: s.row, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            type: "checkbox",
            checked: enabledDraft,
            onChange: (e) => setEnabledDraft(e.target.checked)
          }
        ),
        t("enabled")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: s.row, children: [
        t("port"),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            style: { ...s.input, width: 90 },
            value: portDraft,
            onChange: (e) => setPortDraft(e.target.value)
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: s.row, children: [
        t("bind"),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            style: { ...s.input, width: 220 },
            value: bindDraft,
            onChange: (e) => setBindDraft(e.target.value)
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: s.hint, children: t("bindHint") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...s.hint, color: c.accent }, children: t("saveHint") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.row, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: s.badge, children: [
          t("status"),
          ": ",
          listening ? t("listening") : t("stopped")
        ] }),
        status?.gatewayPort !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: s.badge, children: [
          t("gwPort"),
          ": ",
          status.gatewayPort
        ] })
      ] }),
      status !== null && status.addresses.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: s.hint, children: [
          t("addresses"),
          ":"
        ] }),
        status.addresses.map((a) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.row, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: s.badge, children: a.kind === "tailscale" ? t("ts") : t("lan") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: s.code, children: a.ip })
        ] }, `${a.kind}-${a.ip}`))
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.section, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { style: s.sectionTitle, children: t("pairing") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: s.row, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: s.primaryButton, disabled: !listening, onClick: () => {
        void genLink();
      }, children: t("genLink") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: s.hint, children: t("linkHint") }),
      links !== null && links.map((l) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.row, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: s.badge, children: l.kind === "tailscale" ? t("ts") : t("lan") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: s.code, children: l.url }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: s.button, onClick: () => {
          void copy(l.url);
        }, children: copiedUrl === l.url ? t("copied") : t("copy") })
      ] }, l.url))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.section, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { style: s.sectionTitle, children: t("devices") }),
      status === null || status.devices.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: s.hint, children: t("noDevices") }) : status.devices.map((d) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.row, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 600 }, children: d.name }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: s.hint, children: new Date(d.lastSeenAt).toLocaleString() }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: s.button, onClick: () => {
          void rename(d.id);
        }, children: t("rename") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: { ...s.button, color: c.danger }, onClick: () => {
          void revoke(d.id);
        }, children: t("revoke") })
      ] }, d.id))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.section, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { style: s.sectionTitle, children: t("recent") }),
      status === null || status.log.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: s.hint, children: "\u2014" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { style: s.log, children: status.log.join("\n") })
    ] })
  ] });
}

// src/client/locales.ts
var zh = {
  nav: "\u8FDC\u7A0B\u8BBF\u95EE",
  title: "\u8FDC\u7A0B\u8BBF\u95EE\u7F51\u5173",
  desc: "\u5728\u5C40\u57DF\u7F51\u6216 Tailscale \u7B49\u7EC4\u7F51\u4E0A\u8BBF\u95EE\u672C\u673A dsh\u3002\u9ED8\u8BA4\u5173\u95ED\uFF1B\u624B\u673A/\u79FB\u52A8\u7AEF\u8BF7\u4F7F\u7528 dsh-im-bot \u7684 IM \u901A\u9053\u3002",
  enabled: "\u542F\u7528\u8FDC\u7A0B\u8BBF\u95EE",
  port: "\u7AEF\u53E3",
  bind: "\u7ED1\u5B9A\u5730\u5740",
  bindHint: "0.0.0.0 = \u6240\u6709\u7F51\u5361\uFF1B\u586B Tailscale IP\uFF08100.x\uFF09\u53EF\u53EA\u66B4\u9732\u7ED9\u7EC4\u7F51\u3002",
  status: "\u72B6\u6001",
  listening: "\u76D1\u542C\u4E2D",
  stopped: "\u5DF2\u505C\u7528",
  addresses: "\u8BBF\u95EE\u5730\u5740",
  lan: "\u5C40\u57DF\u7F51",
  ts: "Tailscale",
  pairing: "\u914D\u5BF9",
  genLink: "\u751F\u6210\u914D\u5BF9\u94FE\u63A5",
  linkHint: "\u914D\u5BF9\u7801 10 \u5206\u949F\u5185\u6709\u6548\u3001\u4EC5\u53EF\u7528\u4E00\u6B21\u3002\u5728\u76EE\u6807\u8BBE\u5907\u6D4F\u89C8\u5668\u6253\u5F00\u94FE\u63A5\u5B8C\u6210\u914D\u5BF9\u3002",
  copied: "\u5DF2\u590D\u5236",
  copy: "\u590D\u5236",
  devices: "\u5DF2\u914D\u5BF9\u8BBE\u5907",
  noDevices: "\u6682\u65E0\u8BBE\u5907",
  rename: "\u91CD\u547D\u540D",
  revoke: "\u540A\u9500",
  revokeConfirm: "\u540A\u9500\u540E\u8BE5\u8BBE\u5907\u5C06\u7ACB\u5373\u5931\u53BB\u8BBF\u95EE\u6743\uFF0C\u786E\u5B9A\uFF1F",
  recent: "\u6700\u8FD1\u4E8B\u4EF6",
  unsaved: "\u6709\u672A\u4FDD\u5B58\u66F4\u6539",
  gwPort: "\u5B9E\u9645\u76D1\u542C\u7AEF\u53E3",
  saveHint: "\u914D\u7F6E\u4FEE\u6539\u8BF7\u5728 \u8BBE\u7F6E \u2192 \u63D2\u4EF6 \u5206\u533A\u7684 remote \u914D\u7F6E\u8282\u4FDD\u5B58\uFF08\u70ED\u751F\u6548\uFF09"
};
var en = {
  nav: "Remote Access",
  title: "Remote Access Gateway",
  desc: "Reach this dsh over LAN or mesh VPN (Tailscale). Off by default; use dsh-im-bot for phones.",
  enabled: "Enable remote access",
  port: "Port",
  bind: "Bind address",
  bindHint: "0.0.0.0 = all interfaces; set a Tailscale IP (100.x) to expose to the mesh only.",
  status: "Status",
  listening: "Listening",
  stopped: "Stopped",
  addresses: "Addresses",
  lan: "LAN",
  ts: "Tailscale",
  pairing: "Pairing",
  genLink: "Generate pairing link",
  linkHint: "Codes expire in 10 minutes and work once. Open the link on the target device.",
  copied: "Copied",
  copy: "Copy",
  devices: "Paired devices",
  noDevices: "No devices",
  rename: "Rename",
  revoke: "Revoke",
  revokeConfirm: "Revoke access immediately for this device?",
  recent: "Recent events",
  unsaved: "Unsaved changes",
  gwPort: "Listening port",
  saveHint: "Save config changes via the remote section under Settings \u2192 Plugins (hot reload)"
};

// src/client/index.ts
var inject = ["slots", "locale"];
var NS = "remote";
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-remote: copy dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "dsh-remote",
    order: 26,
    label: () => t("nav"),
    locale: NS,
    inject: () => ({ t: (key) => t(key) })
  }, RemoteTab));
}
		return module.exports;
	}
});
//# sourceMappingURL=client.js.map
