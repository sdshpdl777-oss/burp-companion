
(function () {
  const MAX = 500_000; // don't ship bodies bigger than ~500 KB to the UI

  // Request headers/body as plain data so the popup can re-send the same call.
  function headerList(h) {
    const out = [];
    try {
      if (!h) return out;
      if (typeof h.forEach === "function" && !Array.isArray(h)) h.forEach((v, k) => out.push([k, v]));
      else if (Array.isArray(h)) h.forEach(([k, v]) => out.push([k, v]));
      else Object.keys(h).forEach((k) => out.push([k, h[k]]));
    } catch (_) { }
    return out.map(([k, v]) => ({ name: String(k), value: String(v) }));
  }
  function bodyString(b) {
    if (b == null) return "";
    if (typeof b === "string") return b;
    if (b instanceof URLSearchParams) return b.toString();
    return "";
  }

  function post(url, method, status, contentType, bodyText, req) {
    try {
      let abs = url;
      try { abs = new URL(url, location.href).href; } catch (_) { }
      window.postMessage({
        __burpCap: true,
        payload: {
          url: abs,
          method: (method || "GET").toUpperCase(),
          status: status || 0,
          contentType: contentType || "",
          bodyText: (bodyText || "").slice(0, MAX),
          ts: Date.now(),
          reqHeaders: (req && req.headers) || [],
          reqBody: ((req && req.body) || "").slice(0, MAX)
        }
      }, "*");
    } catch (_) { }
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      p.then((res) => {
        try {
          if (!res) return;
          const clone = res.clone();
          let url = "";
          let method = "GET";
          let headersObj = null;
          let bodyVal = "";

          if (typeof input === "string" || input instanceof URL) {
            url = String(input);
            method = (init && init.method) || "GET";
            headersObj = init && init.headers;
            bodyVal = init && init.body;
          } else if (input && typeof input === "object") {
            url = input.url || "";
            method = (init && init.method) || input.method || "GET";
            headersObj = (init && init.headers) || input.headers;
            bodyVal = (init && init.body);
          }

          const ct = res.headers.get("content-type") || "";
          const req = {
            headers: headerList(headersObj),
            body: bodyString(bodyVal)
          };
          clone.text().then((txt) => post(url, method, res.status, ct, txt, req)).catch(() => { });
        } catch (_) { }
      }).catch(() => { });
      return p;
    };
  }

  // ---- XMLHttpRequest ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__burp = { method, url, headers: [] };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { if (this.__burp) this.__burp.headers.push({ name: String(name), value: String(value) }); } catch (_) { }
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__burp) this.__burp.body = bodyString(body);
    const self = this;
    const handler = function () {
      try {
        const ct = self.getResponseHeader("content-type") || "";
        const info = self.__burp || {};
        const done = (txt) => post(info.url, info.method, self.status, ct, txt, { headers: info.headers, body: info.body });
        const rt = self.responseType;
        try {
          if (rt === "" || rt === "text") done(self.responseText);
          else if (rt === "json") done(typeof self.response === "string" ? self.response : JSON.stringify(self.response));
          else if (rt === "arraybuffer" && self.response) done(new TextDecoder().decode(self.response));
          else if (rt === "blob" && self.response) self.response.text().then(done, () => done(""));
          else if (rt === "document" && self.response) done(new XMLSerializer().serializeToString(self.response));
          else done("");
        } catch (_) { done(""); }
      } catch (_) { }
    };
    this.addEventListener("loadend", handler);
    return origSend.apply(this, arguments);
  };

  // ---- WebSocket (messages the server pushes to the page) ----
  const OrigWS = window.WebSocket;
  if (typeof OrigWS === "function") {
    const decode = (data, done) => {
      if (typeof data === "string") return done(data);
      try {
        if (data instanceof ArrayBuffer) return done(new TextDecoder().decode(data));
        if (data instanceof Blob) return void data.text().then(done, () => { });
      } catch (_) { }
    };
    const WrappedWS = function (url, protocols) {
      const ws = arguments.length > 1 ? new OrigWS(url, protocols) : new OrigWS(url);
      ws.addEventListener("message", (ev) => {
        decode(ev.data, (txt) => post(ws.url || String(url), "WS", 101, "websocket", txt));
      });
      return ws;
    };
    WrappedWS.prototype = OrigWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) WrappedWS[k] = OrigWS[k];
    window.WebSocket = WrappedWS;
  }

  // ---- Server-Sent Events (EventSource: live updates pushed by the server) ----
  const OrigES = window.EventSource;
  if (typeof OrigES === "function") {
    const WrappedES = function (url, config) {
      const es = new OrigES(url, config);
      const origAdd = es.addEventListener.bind(es);
      const seenTypes = new Set();
      const watch = (type) => {
        if (seenTypes.has(type)) return;
        seenTypes.add(type);
        origAdd(type, (ev) => post(es.url || String(url), "SSE", 200, "text/event-stream", String(ev.data)));
      };
      watch("message");
      // Named events (`event: result`) only fire for listeners of that name.
      es.addEventListener = function (type, ...rest) {
        if (type !== "open" && type !== "error") watch(type);
        return origAdd(type, ...rest);
      };
      return es;
    };
    WrappedES.prototype = OrigES.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSED"]) WrappedES[k] = OrigES[k];
    window.EventSource = WrappedES;
  }
})();
