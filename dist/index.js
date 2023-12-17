"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const child_process_1 = require("child_process");
const path_1 = require("path");
const url_1 = require("url");
const http_1 = require("http");
const https_1 = require("https");
const net_1 = require("net");
/**
 * Wait for the specified port to open.
 * @param port The port to watch for.
 * @param retries The number of times to retry before giving up. Defaults to 10.
 * @param interval The interval between retries, in milliseconds. Defaults to 500.
 */
function waitForPort(port, retries = 10, interval = 500) {
    return new Promise((resolve, reject) => {
        let retriesRemaining = retries;
        let retryInterval = interval;
        let timer = null;
        let socket = null;
        function clearTimerAndDestroySocket() {
            clearTimeout(timer);
            timer = null;
            if (socket)
                socket.destroy();
            socket = null;
        }
        function retry() {
            tryToConnect();
        }
        function tryToConnect() {
            clearTimerAndDestroySocket();
            if (--retriesRemaining < 0) {
                reject(new Error('out of retries'));
            }
            socket = net_1.createConnection(port, "localhost", function () {
                clearTimerAndDestroySocket();
                if (retriesRemaining >= 0)
                    resolve();
            });
            timer = setTimeout(function () { retry(); }, retryInterval);
            socket.on('error', function (err) {
                clearTimerAndDestroySocket();
                setTimeout(retry, retryInterval);
            });
        }
        tryToConnect();
    });
}
/**
 * An interceptor that does nothing.
 */
function nopInterceptor(m) { }
exports.nopInterceptor = nopInterceptor;
/**
 * Abstract class that represents HTTP headers.
 */
class AbstractHTTPHeaders {
    // The raw headers, as a sequence of key/value pairs.
    // Since header fields may be repeated, this array may contain multiple entries for the same key.
    get headers() {
        return this._headers;
    }
    constructor(headers) {
        this._headers = headers;
    }
    _indexOfHeader(name) {
        const headers = this.headers;
        const len = headers.length;
        for (let i = 0; i < len; i++) {
            if (headers[i][0].toLowerCase() === name) {
                return i;
            }
        }
        return -1;
    }
    /**
     * Get the value of the given header field.
     * If there are multiple fields with that name, this only returns the first field's value!
     * @param name Name of the header field
     */
    getHeader(name) {
        const index = this._indexOfHeader(name.toLowerCase());
        if (index !== -1) {
            return this.headers[index][1];
        }
        return '';
    }
    /**
     * Set the value of the given header field. Assumes that there is only one field with the given name.
     * If the field does not exist, it adds a new field with the name and value.
     * @param name Name of the field.
     * @param value New value.
     */
    setHeader(name, value) {
        const index = this._indexOfHeader(name.toLowerCase());
        if (index !== -1) {
            this.headers[index][1] = value;
        }
        else {
            this.headers.push([name, value]);
        }
    }
    /**
     * Removes the header field with the given name. Assumes that there is only one field with the given name.
     * Does nothing if field does not exist.
     * @param name Name of the field.
     */
    removeHeader(name) {
        const index = this._indexOfHeader(name.toLowerCase());
        if (index !== -1) {
            this.headers.splice(index, 1);
        }
    }
    /**
     * Removes all header fields.
     */
    clearHeaders() {
        this._headers = [];
    }
}
exports.AbstractHTTPHeaders = AbstractHTTPHeaders;
/**
 * Represents a MITM-ed HTTP response from a server.
 */
class InterceptedHTTPResponse extends AbstractHTTPHeaders {
    constructor(metadata) {
        super(metadata.headers);
        this.statusCode = metadata.status_code;
        // We don't support chunked transfers. The proxy already de-chunks it for us.
        this.removeHeader('transfer-encoding');
        // MITMProxy decodes the data for us.
        this.removeHeader('content-encoding');
        // CSP is bad!
        this.removeHeader('content-security-policy');
        this.removeHeader('x-webkit-csp');
        this.removeHeader('x-content-security-policy');
    }
    toJSON() {
        return {
            status_code: this.statusCode,
            headers: this.headers
        };
    }
}
exports.InterceptedHTTPResponse = InterceptedHTTPResponse;
/**
 * Represents an intercepted HTTP request from a client.
 */
class InterceptedHTTPRequest extends AbstractHTTPHeaders {
    constructor(metadata) {
        super(metadata.headers);
        this.address = metadata.address;
        this.port = metadata.port;
        this.method = metadata.method.toLowerCase();
        this.rawUrl = metadata.url;
        this.url = url_1.parse(this.rawUrl);
    }
}
exports.InterceptedHTTPRequest = InterceptedHTTPRequest;
/**
 * Represents an intercepted HTTP request/response pair.
 */
class InterceptedHTTPMessage {
    /**
     * Unpack from a Buffer received from MITMProxy.
     * @param b
     */
    static FromBuffer(b) {
        const metadataSize = b.readInt32LE(0);
        const requestSize = b.readInt32LE(4);
        const responseSize = b.readInt32LE(8);
        const metadata = JSON.parse(b.toString("utf8", 12, 12 + metadataSize));
        return new InterceptedHTTPMessage(new InterceptedHTTPRequest(metadata.request), new InterceptedHTTPResponse(metadata.response), b.slice(12 + metadataSize, 12 + metadataSize + requestSize), b.slice(12 + metadataSize + requestSize, 12 + metadataSize + requestSize + responseSize));
    }
    // The body of the HTTP response. Read-only; change the response body via setResponseBody.
    get responseBody() {
        return this._responseBody;
    }
    constructor(request, response, requestBody, responseBody) {
        this.request = request;
        this.response = response;
        this.requestBody = requestBody;
        this._responseBody = responseBody;
    }
    /**
     * Changes the body of the HTTP response. Appropriately updates content-length.
     * @param b The new body contents.
     */
    setResponseBody(b) {
        this._responseBody = b;
        // Update content-length.
        this.response.setHeader('content-length', `${b.length}`);
        // TODO: Content-encoding?
    }
    /**
     * Changes the status code of the HTTP response.
     * @param code The new status code.
     */
    setStatusCode(code) {
        this.response.statusCode = code;
    }
    /**
     * Pack into a buffer for transmission to MITMProxy.
     */
    toBuffer() {
        const metadata = Buffer.from(JSON.stringify(this.response), 'utf8');
        const metadataLength = metadata.length;
        const responseLength = this._responseBody.length;
        const rv = Buffer.alloc(8 + metadataLength + responseLength);
        rv.writeInt32LE(metadataLength, 0);
        rv.writeInt32LE(responseLength, 4);
        metadata.copy(rv, 8);
        this._responseBody.copy(rv, 8 + metadataLength);
        return rv;
    }
}
exports.InterceptedHTTPMessage = InterceptedHTTPMessage;
class StashedItem {
    constructor(rawUrl, mimeType, data) {
        this.rawUrl = rawUrl;
        this.mimeType = mimeType;
        this.data = data;
    }
    get shortMimeType() {
        let mime = this.mimeType.toLowerCase();
        if (mime.indexOf(";") !== -1) {
            mime = mime.slice(0, mime.indexOf(";"));
        }
        return mime;
    }
    get isHtml() {
        return this.shortMimeType === "text/html";
    }
    get isJavaScript() {
        switch (this.shortMimeType) {
            case 'text/javascript':
            case 'application/javascript':
            case 'text/x-javascript':
            case 'application/x-javascript':
                return true;
            default:
                return false;
        }
    }
}
exports.StashedItem = StashedItem;
function defaultStashFilter(url, item) {
    return item.isJavaScript || item.isHtml;
}
/**
 * Class that launches MITM proxy and talks to it via WebSockets.
 */
class MITMProxy {
    constructor(cb, onlyInterceptTextFiles) {
        this._stashEnabled = false;
        this._mitmProcess = null;
        this._mitmError = null;
        this._wss = null;
        this._stash = new Map();
        this._stashFilter = defaultStashFilter;
        this.cb = cb;
        this.onlyInterceptTextFiles = onlyInterceptTextFiles;
    }
    /**
     * Creates a new MITMProxy instance.
     * @param cb Called with intercepted HTTP requests / responses.
     * @param interceptPaths List of paths to completely intercept without sending to the server (e.g. ['/eval'])
     * @param quiet If true, do not print debugging messages (defaults to 'true').
     * @param onlyInterceptTextFiles If true, only intercept text files (JavaScript/HTML/CSS/etc, and ignore media files).
     */
    static Create(cb = nopInterceptor, interceptPaths = [], quiet = true, onlyInterceptTextFiles = false, ignoreHosts = null) {
        return __awaiter(this, void 0, void 0, function* () {
            // Construct WebSocket server, and wait for it to begin listening.
            const wss = new ws_1.Server({ port: 8765 });
            const proxyConnected = new Promise((resolve, reject) => {
                wss.once('connection', () => {
                    resolve();
                });
            });
            const mp = new MITMProxy(cb, onlyInterceptTextFiles);
            // Set up WSS callbacks before MITMProxy connects.
            mp._initializeWSS(wss);
            yield new Promise((resolve, reject) => {
                wss.once('listening', () => {
                    wss.removeListener('error', reject);
                    resolve();
                });
                wss.once('error', reject);
            });
            try {
                try {
                    yield waitForPort(8080, 1);
                    if (!quiet) {
                        console.log(`MITMProxy already running.`);
                    }
                }
                catch (e) {
                    if (!quiet) {
                        console.log(`MITMProxy not running; starting up mitmproxy.`);
                    }
                    // Start up MITM process.
                    // --anticache means to disable caching, which gets in the way of transparently rewriting content.
                    const scriptArgs = interceptPaths.length > 0 ? ["--set", `intercept=${interceptPaths.join(",")}`] : [];
                    scriptArgs.push("--set", `onlyInterceptTextFiles=${onlyInterceptTextFiles}`);
                    if (ignoreHosts) {
                        scriptArgs.push(`--ignore-hosts`, ignoreHosts);
                    }
                    var path = (process.pkg) ? process.cwd() : __dirname;
                    const options = ["--anticache", "-s", path_1.resolve(path, `../scripts/proxy.py`)].concat(scriptArgs);
                    if (quiet) {
                        options.push('-q');
                    }
                    // allow self-signed SSL certificates
                    options.push("--ssl-insecure");
                    const mitmProcess = child_process_1.spawn("mitmdump", options, {
                        stdio: 'inherit'
                    });
                    const mitmProxyExited = new Promise((_, reject) => {
                        mitmProcess.once('error', reject);
                        mitmProcess.once('exit', reject);
                    });
                    if (MITMProxy._activeProcesses.push(mitmProcess) === 1) {
                        process.on('SIGINT', MITMProxy._cleanup);
                        process.on('exit', MITMProxy._cleanup);
                    }
                    mp._initializeMITMProxy(mitmProcess);
                    // Wait for port 8080 to come online.
                    const waitingForPort = waitForPort(8080);
                    try {
                        // Fails if mitmproxy exits before port becomes available.
                        yield Promise.race([mitmProxyExited, waitingForPort]);
                    }
                    catch (e) {
                        if (e && typeof (e) === 'object' && e.code === "ENOENT") {
                            throw new Error(`mitmdump, which is an executable that ships with mitmproxy, is not on your PATH. Please ensure that you can run mitmdump --version successfully from your command line.`);
                        }
                        else {
                            throw new Error(`Unable to start mitmproxy: ${e}`);
                        }
                    }
                }
                yield proxyConnected;
            }
            catch (e) {
                yield new Promise((resolve) => wss.close(resolve));
                throw e;
            }
            return mp;
        });
    }
    static _cleanup() {
        if (MITMProxy._cleanupCalled) {
            return;
        }
        MITMProxy._cleanupCalled = true;
        MITMProxy._activeProcesses.forEach((p) => {
            p.kill('SIGKILL');
        });
    }
    // Toggle whether or not mitmproxy-node stashes modified server responses.
    // **Not used for performance**, but enables Node.js code to fetch previous server responses from the proxy.
    get stashEnabled() {
        return this._stashEnabled;
    }
    set stashEnabled(v) {
        if (!v) {
            this._stash.clear();
        }
        this._stashEnabled = v;
    }
    get stashFilter() {
        return this._stashFilter;
    }
    set stashFilter(value) {
        if (typeof (value) === 'function') {
            this._stashFilter = value;
        }
        else if (value === null) {
            this._stashFilter = defaultStashFilter;
        }
        else {
            throw new Error(`Invalid stash filter: Expected a function.`);
        }
    }
    _initializeWSS(wss) {
        this._wss = wss;
        this._wss.on('connection', (ws) => {
            ws.on('error', (e) => {
                if (e.code !== "ECONNRESET") {
                    console.log(`WebSocket error: ${e}`);
                }
            });
            ws.on('message', (message) => __awaiter(this, void 0, void 0, function* () {
                const original = InterceptedHTTPMessage.FromBuffer(message);
                const rv = this.cb(original);
                if (rv && typeof (rv) === 'object' && rv.then) {
                    yield rv;
                }
                // Remove transfer-encoding. We don't support chunked.
                if (this._stashEnabled) {
                    const item = new StashedItem(original.request.rawUrl, original.response.getHeader('content-type'), original.responseBody);
                    if (this._stashFilter(original.request.rawUrl, item)) {
                        this._stash.set(original.request.rawUrl, item);
                    }
                }
                ws.send(original.toBuffer());
            }));
        });
    }
    _initializeMITMProxy(mitmProxy) {
        this._mitmProcess = mitmProxy;
        this._mitmProcess.on('exit', (code, signal) => {
            const index = MITMProxy._activeProcesses.indexOf(this._mitmProcess);
            if (index !== -1) {
                MITMProxy._activeProcesses.splice(index, 1);
            }
            if (code !== null) {
                if (code !== 0) {
                    this._mitmError = new Error(`Process exited with code ${code}.`);
                }
            }
            else {
                this._mitmError = new Error(`Process exited due to signal ${signal}.`);
            }
        });
        this._mitmProcess.on('error', (err) => {
            this._mitmError = err;
        });
    }
    /**
     * Retrieves the given URL from the stash.
     * @param url
     */
    getFromStash(url) {
        return this._stash.get(url);
    }
    forEachStashItem(cb) {
        this._stash.forEach(cb);
    }
    /**
     * Requests the given URL from the proxy.
     */
    proxyGet(urlString) {
        return __awaiter(this, void 0, void 0, function* () {
            const url = url_1.parse(urlString);
            const get = url.protocol === "http:" ? http_1.get : https_1.get;
            return new Promise((resolve, reject) => {
                const req = get({
                    url: urlString,
                    headers: {
                        host: url.host
                    },
                    host: 'localhost',
                    port: 8080,
                    path: urlString
                }, (res) => {
                    const data = new Array();
                    res.on('data', (chunk) => {
                        data.push(chunk);
                    });
                    res.on('end', () => {
                        const d = Buffer.concat(data);
                        resolve({
                            statusCode: res.statusCode,
                            headers: res.headers,
                            body: d
                        });
                    });
                    res.once('error', reject);
                });
                req.once('error', reject);
            });
        });
    }
    shutdown() {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                const closeWSS = () => {
                    this._wss.close((err) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            resolve();
                        }
                    });
                };
                if (this._mitmProcess && !this._mitmProcess.killed) {
                    this._mitmProcess.once('exit', (code, signal) => {
                        closeWSS();
                    });
                    this._mitmProcess.kill('SIGTERM');
                }
                else {
                    closeWSS();
                }
            });
        });
    }
}
MITMProxy._activeProcesses = [];
MITMProxy._cleanupCalled = false;
exports.default = MITMProxy;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7OztBQUFBLDJCQUE2QztBQUM3QyxpREFBa0Q7QUFDbEQsK0JBQTZCO0FBQzdCLDZCQUEyQztBQUMzQywrQkFBb0M7QUFDcEMsaUNBQXNDO0FBQ3RDLDZCQUE2QztBQU83Qzs7Ozs7R0FLRztBQUNILHFCQUFxQixJQUFZLEVBQUUsVUFBa0IsRUFBRSxFQUFFLFdBQW1CLEdBQUc7SUFDN0UsTUFBTSxDQUFDLElBQUksT0FBTyxDQUFPLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1FBQzNDLElBQUksZ0JBQWdCLEdBQUcsT0FBTyxDQUFDO1FBQy9CLElBQUksYUFBYSxHQUFHLFFBQVEsQ0FBQztRQUM3QixJQUFJLEtBQUssR0FBaUIsSUFBSSxDQUFDO1FBQy9CLElBQUksTUFBTSxHQUFXLElBQUksQ0FBQztRQUUxQjtZQUNFLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNwQixLQUFLLEdBQUcsSUFBSSxDQUFDO1lBQ2IsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDO2dCQUFDLE1BQU0sQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUM3QixNQUFNLEdBQUcsSUFBSSxDQUFDO1FBQ2hCLENBQUM7UUFFRDtZQUNFLFlBQVksRUFBRSxDQUFDO1FBQ2pCLENBQUM7UUFFRDtZQUNFLDBCQUEwQixFQUFFLENBQUM7WUFFN0IsRUFBRSxDQUFDLENBQUMsRUFBRSxnQkFBZ0IsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUMzQixNQUFNLENBQUMsSUFBSSxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDO1lBQ3RDLENBQUM7WUFFRCxNQUFNLEdBQUcsc0JBQWdCLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRTtnQkFDM0MsMEJBQTBCLEVBQUUsQ0FBQztnQkFDN0IsRUFBRSxDQUFDLENBQUMsZ0JBQWdCLElB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elBjLDBCQUFnQixHQUFtQixFQUFFLENBQUM7QUF3RnRDLHdCQUFjLEdBQUcsS0FBSyxDQUFDO0FBekZ4Qyw0QkEyUEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1NlcnZlciBhcyBXZWJTb2NrZXRTZXJ2ZXJ9IGZyb20gJ3dzJztcclxuaW1wb3J0IHtzcGF3biwgQ2hpbGRQcm9jZXNzfSBmcm9tICdjaGlsZF9wcm9jZXNzJztcclxuaW1wb3J0IHtyZXNvbHZlfSBmcm9tICdwYXRoJztcclxuaW1wb3J0IHtwYXJzZSBhcyBwYXJzZVVSTCwgVXJsfSBmcm9tICd1cmwnO1xyXG5pbXBvcnQge2dldCBhcyBodHRwR2V0fSBmcm9tICdodHRwJztcclxuaW1wb3J0IHtnZXQgYXMgaHR0cHNHZXR9IGZyb20gJ2h0dHBzJztcclxuaW1wb3J0IHtjcmVhdGVDb25uZWN0aW9uLCBTb2NrZXR9IGZyb20gJ25ldCc7XHJcbmludGVyZmFjZSBQcm9jZXNzIHtcclxuICBwa2c6IGJvb2xlYW4sXHJcbiAgb246IEZ1bmN0aW9uLFxyXG4gIGN3ZDogRnVuY3Rpb25cclxufVxyXG5kZWNsYXJlIHZhciBwcm9jZXNzOiBQcm9jZXNzXHJcbi8qKlxyXG4gKiBXYWl0IGZvciB0aGUgc3BlY2lmaWVkIHBvcnQgdG8gb3Blbi5cclxuICogQHBhcmFtIHBvcnQgVGhlIHBvcnQgdG8gd2F0Y2ggZm9yLlxyXG4gKiBAcGFyYW0gcmV0cmllcyBUaGUgbnVtYmVyIG9mIHRpbWVzIHRvIHJldHJ5IGJlZm9yZSBnaXZpbmcgdXAuIERlZmF1bHRzIHRvIDEwLlxyXG4gKiBAcGFyYW0gaW50ZXJ2YWwgVGhlIGludGVydmFsIGJldHdlZW4gcmV0cmllcywgaW4gbWlsbGlzZWNvbmRzLiBEZWZhdWx0cyB0byA1MDAuXHJcbiAqL1xyXG5mdW5jdGlvbiB3YWl0Rm9yUG9ydChwb3J0OiBudW1iZXIsIHJldHJpZXM6IG51bWJlciA9IDEwLCBpbnRlcnZhbDogbnVtYmVyID0gNTAwKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgIGxldCByZXRyaWVzUmVtYWluaW5nID0gcmV0cmllcztcclxuICAgIGxldCByZXRyeUludGVydmFsID0gaW50ZXJ2YWw7XHJcbiAgICBsZXQgdGltZXI6IE5vZGVKUy5UaW1lciA9IG51bGw7XHJcbiAgICBsZXQgc29ja2V0OiBTb2NrZXQgPSBudWxsO1xyXG5cclxuICAgIGZ1bmN0aW9uIGNsZWFyVGltZXJBbmREZXN0cm95U29ja2V0KCkge1xyXG4gICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xyXG4gICAgICB0aW1lciA9IG51bGw7XHJcbiAgICAgIGlmIChzb2NrZXQpIHNvY2tldC5kZXN0cm95KCk7XHJcbiAgICAgIHNvY2tldCA9IG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgZnVuY3Rpb24gcmV0cnkoKSB7XHJcbiAgICAgIHRyeVRvQ29ubmVjdCgpO1xyXG4gICAgfVxyXG5cclxuICAgIGZ1bmN0aW9uIHRyeVRvQ29ubmVjdCgpIHtcclxuICAgICAgY2xlYXJUaW1lckFuZERlc3Ryb3lTb2NrZXQoKTtcclxuXHJcbiAgICAgIGlmICgtLXJldHJpZXNSZW1haW5pbmcgPCAwKSB7XHJcbiAgICAgICAgcmVqZWN0KG5ldyBFcnJvcignb3V0IG9mIHJldHJpZXMnKSk7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIHNvY2tldCA9IGNyZWF0ZUNvbm5lY3Rpb24ocG9ydCwgXCJsb2NhbGhvc3RcIiwgZnVuY3Rpb24oKSB7XHJcbiAgICAgICAgY2xlYXJUaW1lckFuZERlc3Ryb3lTb2NrZXQoKTtcclxuICAgICAgICBpZiAocmV0cmllc1JlbWFpbmluZyA+PSAwKSByZXNvbHZlKCk7XHJcbiAgICAgIH0pO1xyXG5cclxuICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkgeyByZXRyeSgpOyB9LCByZXRyeUludGVydmFsKTtcclxuXHJcbiAgICAgIHNvY2tldC5vbignZXJyb3InLCBmdW5jdGlvbihlcnIpIHtcclxuICAgICAgICBjbGVhclRpbWVyQW5kRGVzdHJveVNvY2tldCgpO1xyXG4gICAgICAgIHNldFRpbWVvdXQocmV0cnksIHJldHJ5SW50ZXJ2YWwpO1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICB0cnlUb0Nvbm5lY3QoKTtcclxuICB9KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEZ1bmN0aW9uIHRoYXQgaW50ZXJjZXB0cyBhbmQgcmV3cml0ZXMgSFRUUCByZXNwb25zZXMuXHJcbiAqL1xyXG5leHBvcnQgdHlwZSBJbnRlcmNlcHRvciA9IChtOiBJbnRlcmNlcHRlZEhUVFBNZXNzYWdlKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcclxuXHJcbi8qKlxyXG4gKiBBbiBpbnRlcmNlcHRvciB0aGF0IGRvZXMgbm90aGluZy5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBub3BJbnRlcmNlcHRvcihtOiBJbnRlcmNlcHRlZEhUVFBNZXNzYWdlKTogdm9pZCB7fVxyXG5cclxuLyoqXHJcbiAqIFRoZSBjb3JlIEhUVFAgcmVzcG9uc2UuXHJcbiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIEhUVFBSZXNwb25zZSB7XHJcbiAgc3RhdHVzQ29kZTogbnVtYmVyLFxyXG4gIGhlYWRlcnM6IHtbbmFtZTogc3RyaW5nXTogc3RyaW5nfTtcclxuICBib2R5OiBCdWZmZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBNZXRhZGF0YSBhc3NvY2lhdGVkIHdpdGggYSByZXF1ZXN0L3Jlc3BvbnNlIHBhaXIuXHJcbiAqL1xyXG5pbnRlcmZhY2UgSFRUUE1lc3NhZ2VNZXRhZGF0YSB7XHJcbiAgcmVxdWVzdDogSFRUUFJlcXVlc3RNZXRhZGF0YTtcclxuICByZXNwb25zZTogSFRUUFJlc3BvbnNlTWV0YWRhdGE7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBNZXRhZGF0YSBhc3NvY2lhdGVkIHdpdGggYW4gSFRUUCByZXF1ZXN0LlxyXG4gKi9cclxuZXhwb3J0IGludGVyZmFjZSBIVFRQUmVxdWVzdE1ldGFkYXRhIHtcclxuICAvLyBHRVQsIERFTEVURSwgUE9TVCwgIGV0Yy5cclxuICBtZXRob2Q6IHN0cmluZztcclxuICAvL0lQIEFkZHJlc3Mgb2YgQ2xpZW50XHJcbiAgYWRkcmVzczogc3RyaW5nO1xyXG4gIC8vUG9ydCBvZiBDbGllbnRcclxuICBwb3J0OiBudW1iZXI7XHJcbiAgLy8gVGFyZ2V0IFVSTCBmb3IgdGhlIHJlcXVlc3QuXHJcbiAgdXJsOiBzdHJpbmc7XHJcbiAgLy8gVGhlIHNldCBvZiBoZWFkZXJzIGZyb20gdGhlIHJlcXVlc3QsIGFzIGtleS12YWx1ZSBwYWlycy5cclxuICAvLyBTaW5jZSBoZWFkZXIgZmllbGRzIG1heSBiZSByZXBlYXRlZCwgdGhpcyBhcnJheSBtYXkgY29udGFpbiBtdWx0aXBsZSBlbnRyaWVzIGZvciB0aGUgc2FtZSBrZXkuXHJcbiAgaGVhZGVyczogW3N0cmluZywgc3RyaW5nXVtdO1xyXG59XHJcblxyXG4vKipcclxuICogTWV0YWRhdGEgYXNzb2NpYXRlZCB3aXRoIGFuIEhUVFAgcmVzcG9uc2UuXHJcbiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIEhUVFBSZXNwb25zZU1ldGFkYXRhIHtcclxuICAvLyBUaGUgbnVtZXJpY2FsIHN0YXR1cyBjb2RlLlxyXG4gIHN0YXR1c19jb2RlOiBudW1iZXI7XHJcbiAgLy8gVGhlIHNldCBvZiBoZWFkZXJzIGZyb20gdGhlIHJlc3BvbnNlLCBhcyBrZXktdmFsdWUgcGFpcnMuXHJcbiAgLy8gU2luY2UgaGVhZGVyIGZpZWxkcyBtYXkgYmUgcmVwZWF0ZWQsIHRoaXMgYXJyYXkgbWF5IGNvbnRhaW4gbXVsdGlwbGUgZW50cmllcyBmb3IgdGhlIHNhbWUga2V5LlxyXG4gIGhlYWRlcnM6IFtzdHJpbmcsIHN0cmluZ11bXTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEFic3RyYWN0IGNsYXNzIHRoYXQgcmVwcmVzZW50cyBIVFRQIGhlYWRlcnMuXHJcbiAqL1xyXG5leHBvcnQgYWJzdHJhY3QgY2xhc3MgQWJzdHJhY3RIVFRQSGVhZGVycyB7XHJcbiAgcHJpdmF0ZSBfaGVhZGVyczogW3N0cmluZywgc3RyaW5nXVtdO1xyXG4gIC8vIFRoZSByYXcgaGVhZGVycywgYXMgYSBzZXF1ZW5jZSBvZiBrZXkvdmFsdWUgcGFpcnMuXHJcbiAgLy8gU2luY2UgaGVhZGVyIGZpZWxkcyBtYXkgYmUgcmVwZWF0ZWQsIHRoaXMgYXJyYXkgbWF5IGNvbnRhaW4gbXVsdGlwbGUgZW50cmllcyBmb3IgdGhlIHNhbWUga2V5LlxyXG4gIHB1YmxpYyBnZXQgaGVhZGVycygpOiBbc3RyaW5nLCBzdHJpbmddW10ge1xyXG4gICAgcmV0dXJuIHRoaXMuX2hlYWRlcnM7XHJcbiAgfVxyXG4gIGNvbnN0cnVjdG9yKGhlYWRlcnM6IFtzdHJpbmcsIHN0cmluZ11bXSkge1xyXG4gICAgdGhpcy5faGVhZGVycyA9IGhlYWRlcnM7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIF9pbmRleE9mSGVhZGVyKG5hbWU6IHN0cmluZyk6IG51bWJlciB7XHJcbiAgICBjb25zdCBoZWFkZXJzID0gdGhpcy5oZWFkZXJzO1xyXG4gICAgY29uc3QgbGVuID0gaGVhZGVycy5sZW5ndGg7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxlbjsgaSsrKSB7XHJcbiAgICAgIGlmIChoZWFkZXJzW2ldWzBdLnRvTG93ZXJDYXNlKCkgPT09IG5hbWUpIHtcclxuICAgICAgICByZXR1cm4gaTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIC0xO1xyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogR2V0IHRoZSB2YWx1ZSBvZiB0aGUgZ2l2ZW4gaGVhZGVyIGZpZWxkLlxyXG4gICAqIElmIHRoZXJlIGFyZSBtdWx0aXBsZSBmaWVsZHMgd2l0aCB0aGF0IG5hbWUsIHRoaXMgb25seSByZXR1cm5zIHRoZSBmaXJzdCBmaWVsZCdzIHZhbHVlIVxyXG4gICAqIEBwYXJhbSBuYW1lIE5hbWUgb2YgdGhlIGhlYWRlciBmaWVsZFxyXG4gICAqL1xyXG4gIHB1YmxpYyBnZXRIZWFkZXIobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IGluZGV4ID0gdGhpcy5faW5kZXhPZkhlYWRlcihuYW1lLnRvTG93ZXJDYXNlKCkpO1xyXG4gICAgaWYgKGluZGV4ICE9PSAtMSkge1xyXG4gICAgICByZXR1cm4gdGhpcy5oZWFkZXJzW2luZGV4XVsxXTtcclxuICAgIH1cclxuICAgIHJldHVybiAnJztcclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFNldCB0aGUgdmFsdWUgb2YgdGhlIGdpdmVuIGhlYWRlciBmaWVsZC4gQXNzdW1lcyB0aGF0IHRoZXJlIGlzIG9ubHkgb25lIGZpZWxkIHdpdGggdGhlIGdpdmVuIG5hbWUuXHJcbiAgICogSWYgdGhlIGZpZWxkIGRvZXMgbm90IGV4aXN0LCBpdCBhZGRzIGEgbmV3IGZpZWxkIHdpdGggdGhlIG5hbWUgYW5kIHZhbHVlLlxyXG4gICAqIEBwYXJhbSBuYW1lIE5hbWUgb2YgdGhlIGZpZWxkLlxyXG4gICAqIEBwYXJhbSB2YWx1ZSBOZXcgdmFsdWUuXHJcbiAgICovXHJcbiAgcHVibGljIHNldEhlYWRlcihuYW1lOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcclxuICAgIGNvbnN0IGluZGV4ID0gdGhpcy5faW5kZXhPZkhlYWRlcihuYW1lLnRvTG93ZXJDYXNlKCkpO1xyXG4gICAgaWYgKGluZGV4ICE9PSAtMSkge1xyXG4gICAgICB0aGlzLmhlYWRlcnNbaW5kZXhdWzFdID0gdmFsdWU7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aGlzLmhlYWRlcnMucHVzaChbbmFtZSwgdmFsdWVdKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFJlbW92ZXMgdGhlIGhlYWRlciBmaWVsZCB3aXRoIHRoZSBnaXZlbiBuYW1lLiBBc3N1bWVzIHRoYXQgdGhlcmUgaXMgb25seSBvbmUgZmllbGQgd2l0aCB0aGUgZ2l2ZW4gbmFtZS5cclxuICAgKiBEb2VzIG5vdGhpbmcgaWYgZmllbGQgZG9lcyBub3QgZXhpc3QuXHJcbiAgICogQHBhcmFtIG5hbWUgTmFtZSBvZiB0aGUgZmllbGQuXHJcbiAgICovXHJcbiAgcHVibGljIHJlbW92ZUhlYWRlcihuYW1lOiBzdHJpbmcpOiB2b2lkIHtcclxuICAgIGNvbnN0IGluZGV4ID0gdGhpcy5faW5kZXhPZkhlYWRlcihuYW1lLnRvTG93ZXJDYXNlKCkpO1xyXG4gICAgaWYgKGluZGV4ICE9PSAtMSkge1xyXG4gICAgICB0aGlzLmhlYWRlcnMuc3BsaWNlKGluZGV4LCAxKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFJlbW92ZXMgYWxsIGhlYWRlciBmaWVsZHMuXHJcbiAgICovXHJcbiAgcHVibGljIGNsZWFySGVhZGVycygpOiB2b2lkIHtcclxuICAgIHRoaXMuX2hlYWRlcnMgPSBbXTtcclxuICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZXByZXNlbnRzIGEgTUlUTS1lZCBIVFRQIHJlc3BvbnNlIGZyb20gYSBzZXJ2ZXIuXHJcbiAqL1xyXG5leHBvcnQgY2xhc3MgSW50ZXJjZXB0ZWRIVFRQUmVzcG9uc2UgZXh0ZW5kcyBBYnN0cmFjdEhUVFBIZWFkZXJzIHtcclxuICAvLyBUaGUgc3RhdHVzIGNvZGUgb2YgdGhlIEhUVFAgcmVzcG9uc2UuXHJcbiAgcHVibGljIHN0YXR1c0NvZGU6IG51bWJlcjtcclxuXHJcbiAgY29uc3RydWN0b3IobWV0YWRhdGE6IEhUVFBSZXNwb25zZU1ldGFkYXRhKSB7XHJcbiAgICBzdXBlcihtZXRhZGF0YS5oZWFkZXJzKTtcclxuICAgIHRoaXMuc3RhdHVzQ29kZSA9IG1ldGFkYXRhLnN0YXR1c19jb2RlO1xyXG4gICAgLy8gV2UgZG9uJ3Qgc3VwcG9ydCBjaHVua2VkIHRyYW5zZmVycy4gVGhlIHByb3h5IGFscmVhZHkgZGUtY2h1bmtzIGl0IGZvciB1cy5cclxuICAgIHRoaXMucmVtb3ZlSGVhZGVyKCd0cmFuc2Zlci1lbmNvZGluZycpO1xyXG4gICAgLy8gTUlUTVByb3h5IGRlY29kZXMgdGhlIGRhdGEgZm9yIHVzLlxyXG4gICAgdGhpcy5yZW1vdmVIZWFkZXIoJ2NvbnRlbnQtZW5jb2RpbmcnKTtcclxuICAgIC8vIENTUCBpcyBiYWQhXHJcbiAgICB0aGlzLnJlbW92ZUhlYWRlcignY29udGVudC1zZWN1cml0eS1wb2xpY3knKTtcclxuICAgIHRoaXMucmVtb3ZlSGVhZGVyKCd4LXdlYmtpdC1jc3AnKTtcclxuICAgIHRoaXMucmVtb3ZlSGVhZGVyKCd4LWNvbnRlbnQtc2VjdXJpdHktcG9saWN5Jyk7XHJcbiAgfVxyXG5cclxuICBwdWJsaWMgdG9KU09OKCk6IEhUVFBSZXNwb25zZU1ldGFkYXRhIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgIHN0YXR1c19jb2RlOiB0aGlzLnN0YXR1c0NvZGUsXHJcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVyc1xyXG4gICAgfTtcclxuICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZXByZXNlbnRzIGFuIGludGVyY2VwdGVkIEhUVFAgcmVxdWVzdCBmcm9tIGEgY2xpZW50LlxyXG4gKi9cclxuZXhwb3J0IGNsYXNzIEludGVyY2VwdGVkSFRUUFJlcXVlc3QgZXh0ZW5kcyBBYnN0cmFjdEhUVFBIZWFkZXJzIHtcclxuICAvLyBIVFRQIG1ldGhvZCAoR0VUL0RFTEVURS9ldGMpXHJcbiAgcHVibGljIG1ldGhvZDogc3RyaW5nO1xyXG4gIC8vIFRoZSBVUkwgYXMgYSBzdHJpbmcuXHJcbiAgcHVibGljIHJhd1VybDogc3RyaW5nO1xyXG4gIC8vIFRoZSBVUkwgYXMgYSBVUkwgb2JqZWN0LlxyXG4gIHB1YmxpYyB1cmw6IFVybDtcclxuICAvL0lQIEFkZHJlc3Mgb2YgQ2xpZW50XHJcbiAgcHVibGljIGFkZHJlc3M6IHN0cmluZztcclxuICAvL1BvcnQgb2YgQ2xpZW50XHJcbiAgcHVibGljIHBvcnQ6IG51bWJlcjtcclxuXHJcbiAgY29uc3RydWN0b3IobWV0YWRhdGE6IEhUVFBSZXF1ZXN0TWV0YWRhdGEpIHtcclxuICAgIHN1cGVyKG1ldGFkYXRhLmhlYWRlcnMpO1xyXG4gICAgdGhpcy5hZGRyZXNzID0gbWV0YWRhdGEuYWRkcmVzcztcclxuICAgIHRoaXMucG9ydCA9IG1ldGFkYXRhLnBvcnQ7XHJcbiAgICB0aGlzLm1ldGhvZCA9IG1ldGFkYXRhLm1ldGhvZC50b0xvd2VyQ2FzZSgpO1xyXG4gICAgdGhpcy5yYXdVcmwgPSBtZXRhZGF0YS51cmw7XHJcbiAgICB0aGlzLnVybCA9IHBhcnNlVVJMKHRoaXMucmF3VXJsKTtcclxuICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZXByZXNlbnRzIGFuIGludGVyY2VwdGVkIEhUVFAgcmVxdWVzdC9yZXNwb25zZSBwYWlyLlxyXG4gKi9cclxuZXhwb3J0IGNsYXNzIEludGVyY2VwdGVkSFRUUE1lc3NhZ2Uge1xyXG4gIC8qKlxyXG4gICAqIFVucGFjayBmcm9tIGEgQnVmZmVyIHJlY2VpdmVkIGZyb20gTUlUTVByb3h5LlxyXG4gICAqIEBwYXJhbSBiXHJcbiAgICovXHJcbiAgcHVibGljIHN0YXRpYyBGcm9tQnVmZmVyKGI6IEJ1ZmZlcik6IEludGVyY2VwdGVkSFRUUE1lc3NhZ2Uge1xyXG4gICAgY29uc3QgbWV0YWRhdGFTaXplID0gYi5yZWFkSW50MzJMRSgwKTtcclxuICAgIGNvbnN0IHJlcXVlc3RTaXplID0gYi5yZWFkSW50MzJMRSg0KTtcclxuICAgIGNvbnN0IHJlc3BvbnNlU2l6ZSA9IGIucmVhZEludDMyTEUoOCk7XHJcbiAgICBjb25zdCBtZXRhZGF0YTogSFRUUE1lc3NhZ2VNZXRhZGF0YSA9IEpTT04ucGFyc2UoYi50b1N0cmluZyhcInV0ZjhcIiwgMTIsIDEyICsgbWV0YWRhdGFTaXplKSk7XHJcbiAgICByZXR1cm4gbmV3IEludGVyY2VwdGVkSFRUUE1lc3NhZ2UoXHJcbiAgICAgIG5ldyBJbnRlcmNlcHRlZEhUVFBSZXF1ZXN0KG1ldGFkYXRhLnJlcXVlc3QpLFxyXG4gICAgICBuZXcgSW50ZXJjZXB0ZWRIVFRQUmVzcG9uc2UobWV0YWRhdGEucmVzcG9uc2UpLFxyXG4gICAgICBiLnNsaWNlKDEyICsgbWV0YWRhdGFTaXplLCAxMiArIG1ldGFkYXRhU2l6ZSArIHJlcXVlc3RTaXplKSxcclxuICAgICAgYi5zbGljZSgxMiArIG1ldGFkYXRhU2l6ZSArIHJlcXVlc3RTaXplLCAxMiArIG1ldGFkYXRhU2l6ZSArIHJlcXVlc3RTaXplICsgcmVzcG9uc2VTaXplKVxyXG4gICAgKTtcclxuICB9XHJcblxyXG4gIHB1YmxpYyByZWFkb25seSByZXF1ZXN0OiBJbnRlcmNlcHRlZEhUVFBSZXF1ZXN0O1xyXG4gIHB1YmxpYyByZWFkb25seSByZXNwb25zZTogSW50ZXJjZXB0ZWRIVFRQUmVzcG9uc2U7XHJcbiAgLy8gVGhlIGJvZHkgb2YgdGhlIEhUVFAgcmVxdWVzdC5cclxuICBwdWJsaWMgcmVhZG9ubHkgcmVxdWVzdEJvZHk6IEJ1ZmZlcjtcclxuICAvLyBUaGUgYm9keSBvZiB0aGUgSFRUUCByZXNwb25zZS4gUmVhZC1vbmx5OyBjaGFuZ2UgdGhlIHJlc3BvbnNlIGJvZHkgdmlhIHNldFJlc3BvbnNlQm9keS5cclxuICBwdWJsaWMgZ2V0IHJlc3BvbnNlQm9keSgpOiBCdWZmZXIge1xyXG4gICAgcmV0dXJuIHRoaXMuX3Jlc3BvbnNlQm9keTtcclxuICB9XHJcbiAgcHJpdmF0ZSBfcmVzcG9uc2VCb2R5OiBCdWZmZXI7XHJcbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcihyZXF1ZXN0OiBJbnRlcmNlcHRlZEhUVFBSZXF1ZXN0LCByZXNwb25zZTogSW50ZXJjZXB0ZWRIVFRQUmVzcG9uc2UsIHJlcXVlc3RCb2R5OiBCdWZmZXIsIHJlc3BvbnNlQm9keTogQnVmZmVyKSB7XHJcbiAgICB0aGlzLnJlcXVlc3QgPSByZXF1ZXN0O1xyXG4gICAgdGhpcy5yZXNwb25zZSA9IHJlc3BvbnNlO1xyXG4gICAgdGhpcy5yZXF1ZXN0Qm9keSA9IHJlcXVlc3RCb2R5O1xyXG4gICAgdGhpcy5fcmVzcG9uc2VCb2R5ID0gcmVzcG9uc2VCb2R5O1xyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogQ2hhbmdlcyB0aGUgYm9keSBvZiB0aGUgSFRUUCByZXNwb25zZS4gQXBwcm9wcmlhdGVseSB1cGRhdGVzIGNvbnRlbnQtbGVuZ3RoLlxyXG4gICAqIEBwYXJhbSBiIFRoZSBuZXcgYm9keSBjb250ZW50cy5cclxuICAgKi9cclxuICBwdWJsaWMgc2V0UmVzcG9uc2VCb2R5KGI6IEJ1ZmZlcikge1xyXG4gICAgdGhpcy5fcmVzcG9uc2VCb2R5ID0gYjtcclxuICAgIC8vIFVwZGF0ZSBjb250ZW50LWxlbmd0aC5cclxuICAgIHRoaXMucmVzcG9uc2Uuc2V0SGVhZGVyKCdjb250ZW50LWxlbmd0aCcsIGAke2IubGVuZ3RofWApO1xyXG4gICAgLy8gVE9ETzogQ29udGVudC1lbmNvZGluZz9cclxuICB9XHJcbiAgXHJcbiAgLyoqXHJcbiAgICogQ2hhbmdlcyB0aGUgc3RhdHVzIGNvZGUgb2YgdGhlIEhUVFAgcmVzcG9uc2UuXHJcbiAgICogQHBhcmFtIGNvZGUgVGhlIG5ldyBzdGF0dXMgY29kZS5cclxuICAgKi9cclxuICBwdWJsaWMgc2V0U3RhdHVzQ29kZShjb2RlOiBudW1iZXIpIHtcclxuICAgIHRoaXMucmVzcG9uc2Uuc3RhdHVzQ29kZSA9IGNvZGU7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBQYWNrIGludG8gYSBidWZmZXIgZm9yIHRyYW5zbWlzc2lvbiB0byBNSVRNUHJveHkuXHJcbiAgICovXHJcbiAgcHVibGljIHRvQnVmZmVyKCk6IEJ1ZmZlciB7XHJcbiAgICBjb25zdCBtZXRhZGF0YSA9IEJ1ZmZlci5mcm9tKEpTT04uc3RyaW5naWZ5KHRoaXMucmVzcG9uc2UpLCAndXRmOCcpO1xyXG4gICAgY29uc3QgbWV0YWRhdGFMZW5ndGggPSBtZXRhZGF0YS5sZW5ndGg7XHJcbiAgICBjb25zdCByZXNwb25zZUxlbmd0aCA9IHRoaXMuX3Jlc3BvbnNlQm9keS5sZW5ndGhcclxuICAgIGNvbnN0IHJ2ID0gQnVmZmVyLmFsbG9jKDggKyBtZXRhZGF0YUxlbmd0aCArIHJlc3BvbnNlTGVuZ3RoKTtcclxuICAgIHJ2LndyaXRlSW50MzJMRShtZXRhZGF0YUxlbmd0aCwgMCk7XHJcbiAgICBydi53cml0ZUludDMyTEUocmVzcG9uc2VMZW5ndGgsIDQpO1xyXG4gICAgbWV0YWRhdGEuY29weShydiwgOCk7XHJcbiAgICB0aGlzLl9yZXNwb25zZUJvZHkuY29weShydiwgOCArIG1ldGFkYXRhTGVuZ3RoKTtcclxuICAgIHJldHVybiBydjtcclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBTdGFzaGVkSXRlbSB7XHJcbiAgY29uc3RydWN0b3IoXHJcbiAgICBwdWJsaWMgcmVhZG9ubHkgcmF3VXJsOiBzdHJpbmcsXHJcbiAgICBwdWJsaWMgcmVhZG9ubHkgbWltZVR5cGU6IHN0cmluZyxcclxuICAgIHB1YmxpYyByZWFkb25seSBkYXRhOiBCdWZmZXIpIHt9XHJcblxyXG4gIHB1YmxpYyBnZXQgc2hvcnRNaW1lVHlwZSgpOiBzdHJpbmcge1xyXG4gICAgbGV0IG1pbWUgPSB0aGlzLm1pbWVUeXBlLnRvTG93ZXJDYXNlKCk7XHJcbiAgICBpZiAobWltZS5pbmRleE9mKFwiO1wiKSAhPT0gLTEpIHtcclxuICAgICAgbWltZSA9IG1pbWUuc2xpY2UoMCwgbWltZS5pbmRleE9mKFwiO1wiKSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbWltZTtcclxuICB9XHJcblxyXG4gIHB1YmxpYyBnZXQgaXNIdG1sKCk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIHRoaXMuc2hvcnRNaW1lVHlwZSA9PT0gXCJ0ZXh0L2h0bWxcIjtcclxuICB9XHJcblxyXG4gIHB1YmxpYyBnZXQgaXNKYXZhU2NyaXB0KCk6IGJvb2xlYW4ge1xyXG4gICAgc3dpdGNoKHRoaXMuc2hvcnRNaW1lVHlwZSkge1xyXG4gICAgICBjYXNlICd0ZXh0L2phdmFzY3JpcHQnOlxyXG4gICAgICBjYXNlICdhcHBsaWNhdGlvbi9qYXZhc2NyaXB0JzpcclxuICAgICAgY2FzZSAndGV4dC94LWphdmFzY3JpcHQnOlxyXG4gICAgICBjYXNlICdhcHBsaWNhdGlvbi94LWphdmFzY3JpcHQnOlxyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICBkZWZhdWx0OlxyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlZmF1bHRTdGFzaEZpbHRlcih1cmw6IHN0cmluZywgaXRlbTogU3Rhc2hlZEl0ZW0pOiBib29sZWFuIHtcclxuICByZXR1cm4gaXRlbS5pc0phdmFTY3JpcHQgfHwgaXRlbS5pc0h0bWw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDbGFzcyB0aGF0IGxhdW5jaGVzIE1JVE0gcHJveHkgYW5kIHRhbGtzIHRvIGl0IHZpYSBXZWJTb2NrZXRzLlxyXG4gKi9cclxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgTUlUTVByb3h5IHtcclxuICBwcml2YXRlIHN0YXRpYyBfYWN0aXZlUHJvY2Vzc2VzOiBDaGlsZFByb2Nlc3NbXSA9IFtdO1xyXG5cclxuICAvKipcclxuICAgKiBDcmVhdGVzIGEgbmV3IE1JVE1Qcm94eSBpbnN0YW5jZS5cclxuICAgKiBAcGFyYW0gY2IgQ2FsbGVkIHdpdGggaW50ZXJjZXB0ZWQgSFRUUCByZXF1ZXN0cyAvIHJlc3BvbnNlcy5cclxuICAgKiBAcGFyYW0gaW50ZXJjZXB0UGF0aHMgTGlzdCBvZiBwYXRocyB0byBjb21wbGV0ZWx5IGludGVyY2VwdCB3aXRob3V0IHNlbmRpbmcgdG8gdGhlIHNlcnZlciAoZS5nLiBbJy9ldmFsJ10pXHJcbiAgICogQHBhcmFtIHF1aWV0IElmIHRydWUsIGRvIG5vdCBwcmludCBkZWJ1Z2dpbmcgbWVzc2FnZXMgKGRlZmF1bHRzIHRvICd0cnVlJykuXHJcbiAgICogQHBhcmFtIG9ubHlJbnRlcmNlcHRUZXh0RmlsZXMgSWYgdHJ1ZSwgb25seSBpbnRlcmNlcHQgdGV4dCBmaWxlcyAoSmF2YVNjcmlwdC9IVE1ML0NTUy9ldGMsIGFuZCBpZ25vcmUgbWVkaWEgZmlsZXMpLlxyXG4gICAqL1xyXG4gIHB1YmxpYyBzdGF0aWMgYXN5bmMgQ3JlYXRlKGNiOiBJbnRlcmNlcHRvciA9IG5vcEludGVyY2VwdG9yLCBpbnRlcmNlcHRQYXRoczogc3RyaW5nW10gPSBbXSwgcXVpZXQ6IGJvb2xlYW4gPSB0cnVlLCBvbmx5SW50ZXJjZXB0VGV4dEZpbGVzID0gZmFsc2UsIGlnbm9yZUhvc3RzOiBzdHJpbmcgfCBudWxsID0gbnVsbCk6IFByb21pc2U8TUlUTVByb3h5PiB7XHJcbiAgICAvLyBDb25zdHJ1Y3QgV2ViU29ja2V0IHNlcnZlciwgYW5kIHdhaXQgZm9yIGl0IHRvIGJlZ2luIGxpc3RlbmluZy5cclxuICAgIGNvbnN0IHdzcyA9IG5ldyBXZWJTb2NrZXRTZXJ2ZXIoeyBwb3J0OiA4NzY1IH0pO1xyXG4gICAgY29uc3QgcHJveHlDb25uZWN0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgIHdzcy5vbmNlKCdjb25uZWN0aW9uJywgKCkgPT4ge1xyXG4gICAgICAgIHJlc29sdmUoKTtcclxuICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIGNvbnN0IG1wID0gbmV3IE1JVE1Qcm94eShjYiwgb25seUludGVyY2VwdFRleHRGaWxlcyk7XHJcbiAgICAvLyBTZXQgdXAgV1NTIGNhbGxiYWNrcyBiZWZvcmUgTUlUTVByb3h5IGNvbm5lY3RzLlxyXG4gICAgbXAuX2luaXRpYWxpemVXU1Mod3NzKTtcclxuICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgd3NzLm9uY2UoJ2xpc3RlbmluZycsICgpID0+IHtcclxuICAgICAgICB3c3MucmVtb3ZlTGlzdGVuZXIoJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgICAgICByZXNvbHZlKCk7XHJcbiAgICAgIH0pO1xyXG4gICAgICB3c3Mub25jZSgnZXJyb3InLCByZWplY3QpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yUG9ydCg4MDgwLCAxKTtcclxuICAgICAgICBpZiAoIXF1aWV0KSB7XHJcbiAgICAgICAgICBjb25zb2xlLmxvZyhgTUlUTVByb3h5IGFscmVhZHkgcnVubmluZy5gKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICBpZiAoIXF1aWV0KSB7XHJcbiAgICAgICAgICBjb25zb2xlLmxvZyhgTUlUTVByb3h5IG5vdCBydW5uaW5nOyBzdGFydGluZyB1cCBtaXRtcHJveHkuYCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIFN0YXJ0IHVwIE1JVE0gcHJvY2Vzcy5cclxuICAgICAgICAvLyAtLWFudGljYWNoZSBtZWFucyB0byBkaXNhYmxlIGNhY2hpbmcsIHdoaWNoIGdldHMgaW4gdGhlIHdheSBvZiB0cmFuc3BhcmVudGx5IHJld3JpdGluZyBjb250ZW50LlxyXG4gICAgICAgIGNvbnN0IHNjcmlwdEFyZ3MgPSBpbnRlcmNlcHRQYXRocy5sZW5ndGggPiAwID8gW1wiLS1zZXRcIiwgYGludGVyY2VwdD0ke2ludGVyY2VwdFBhdGhzLmpvaW4oXCIsXCIpfWBdIDogW107XHJcbiAgICAgICAgc2NyaXB0QXJncy5wdXNoKFwiLS1zZXRcIiwgYG9ubHlJbnRlcmNlcHRUZXh0RmlsZXM9JHtvbmx5SW50ZXJjZXB0VGV4dEZpbGVzfWApO1xyXG4gICAgICAgIGlmIChpZ25vcmVIb3N0cykge1xyXG4gICAgICAgICAgc2NyaXB0QXJncy5wdXNoKGAtLWlnbm9yZS1ob3N0c2AsIGlnbm9yZUhvc3RzKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIHBhdGggPSAocHJvY2Vzcy5wa2cpID8gcHJvY2Vzcy5jd2QoKSA6IF9fZGlybmFtZTtcclxuICAgICAgICBjb25zdCBvcHRpb25zID0gW1wiLS1hbnRpY2FjaGVcIiwgXCItc1wiLCByZXNvbHZlKHBhdGgsIGAuLi9zY3JpcHRzL3Byb3h5LnB5YCldLmNvbmNhdChzY3JpcHRBcmdzKTtcclxuICAgICAgICBpZiAocXVpZXQpIHtcclxuICAgICAgICAgIG9wdGlvbnMucHVzaCgnLXEnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgXHJcbiAgICAgICAgLy8gYWxsb3cgc2VsZi1zaWduZWQgU1NMIGNlcnRpZmljYXRlc1xyXG4gICAgICAgIG9wdGlvbnMucHVzaChcIi0tc3NsLWluc2VjdXJlXCIpO1xyXG4gICAgICAgIFxyXG4gICAgICAgIGNvbnN0IG1pdG1Qcm9jZXNzID0gc3Bhd24oXCJtaXRtZHVtcFwiLCBvcHRpb25zLCB7XHJcbiAgICAgICAgICBzdGRpbzogJ2luaGVyaXQnXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgY29uc3QgbWl0bVByb3h5RXhpdGVkID0gbmV3IFByb21pc2U8dm9pZD4oKF8sIHJlamVjdCkgPT4ge1xyXG4gICAgICAgICAgbWl0bVByb2Nlc3Mub25jZSgnZXJyb3InLCByZWplY3QpO1xyXG4gICAgICAgICAgbWl0bVByb2Nlc3Mub25jZSgnZXhpdCcsIHJlamVjdCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaWYgKE1JVE1Qcm94eS5fYWN0aXZlUHJvY2Vzc2VzLnB1c2gobWl0bVByb2Nlc3MpID09PSAxKSB7XHJcbiAgICAgICAgICBwcm9jZXNzLm9uKCdTSUdJTlQnLCBNSVRNUHJveHkuX2NsZWFudXApO1xyXG4gICAgICAgICAgcHJvY2Vzcy5vbignZXhpdCcsIE1JVE1Qcm94eS5fY2xlYW51cCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIG1wLl9pbml0aWFsaXplTUlUTVByb3h5KG1pdG1Qcm9jZXNzKTtcclxuICAgICAgICAvLyBXYWl0IGZvciBwb3J0IDgwODAgdG8gY29tZSBvbmxpbmUuXHJcbiAgICAgICAgY29uc3Qgd2FpdGluZ0ZvclBvcnQgPSB3YWl0Rm9yUG9ydCg4MDgwKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgLy8gRmFpbHMgaWYgbWl0bXByb3h5IGV4aXRzIGJlZm9yZSBwb3J0IGJlY29tZXMgYXZhaWxhYmxlLlxyXG4gICAgICAgICAgYXdhaXQgUHJvbWlzZS5yYWNlKFttaXRtUHJveHlFeGl0ZWQsIHdhaXRpbmdGb3JQb3J0XSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgaWYgKGUgJiYgdHlwZW9mKGUpID09PSAnb2JqZWN0JyAmJiBlLmNvZGUgPT09IFwiRU5PRU5UXCIpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBtaXRtZHVtcCwgd2hpY2ggaXMgYW4gZXhlY3V0YWJsZSB0aGF0IHNoaXBzIHdpdGggbWl0bXByb3h5LCBpcyBub3Qgb24geW91ciBQQVRILiBQbGVhc2UgZW5zdXJlIHRoYXQgeW91IGNhbiBydW4gbWl0bWR1bXAgLS12ZXJzaW9uIHN1Y2Nlc3NmdWxseSBmcm9tIHlvdXIgY29tbWFuZCBsaW5lLmApXHJcbiAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuYWJsZSB0byBzdGFydCBtaXRtcHJveHk6ICR7ZX1gKTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgYXdhaXQgcHJveHlDb25uZWN0ZWQ7XHJcbiAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlPGFueT4oKHJlc29sdmUpID0+IHdzcy5jbG9zZShyZXNvbHZlKSk7XHJcbiAgICAgIHRocm93IGU7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIG1wO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBzdGF0aWMgX2NsZWFudXBDYWxsZWQgPSBmYWxzZTtcclxuICBwcml2YXRlIHN0YXRpYyBfY2xlYW51cCgpOiB2b2lkIHtcclxuICAgIGlmIChNSVRNUHJveHkuX2NsZWFudXBDYWxsZWQpIHtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgTUlUTVByb3h5Ll9jbGVhbnVwQ2FsbGVkID0gdHJ1ZTtcclxuICAgIE1JVE1Qcm94eS5fYWN0aXZlUHJvY2Vzc2VzLmZvckVhY2goKHApID0+IHtcclxuICAgICAgcC5raWxsKCdTSUdLSUxMJyk7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgX3N0YXNoRW5hYmxlZDogYm9vbGVhbiA9IGZhbHNlO1xyXG4gIC8vIFRvZ2dsZSB3aGV0aGVyIG9yIG5vdCBtaXRtcHJveHktbm9kZSBzdGFzaGVzIG1vZGlmaWVkIHNlcnZlciByZXNwb25zZXMuXHJcbiAgLy8gKipOb3QgdXNlZCBmb3IgcGVyZm9ybWFuY2UqKiwgYnV0IGVuYWJsZXMgTm9kZS5qcyBjb2RlIHRvIGZldGNoIHByZXZpb3VzIHNlcnZlciByZXNwb25zZXMgZnJvbSB0aGUgcHJveHkuXHJcbiAgcHVibGljIGdldCBzdGFzaEVuYWJsZWQoKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gdGhpcy5fc3Rhc2hFbmFibGVkO1xyXG4gIH1cclxuICBwdWJsaWMgc2V0IHN0YXNoRW5hYmxlZCh2OiBib29sZWFuKSB7XHJcbiAgICBpZiAoIXYpIHtcclxuICAgICAgdGhpcy5fc3Rhc2guY2xlYXIoKTtcclxuICAgIH1cclxuICAgIHRoaXMuX3N0YXNoRW5hYmxlZCA9IHY7XHJcbiAgfVxyXG4gIHByaXZhdGUgX21pdG1Qcm9jZXNzOiBDaGlsZFByb2Nlc3MgPSBudWxsO1xyXG4gIHByaXZhdGUgX21pdG1FcnJvcjogRXJyb3IgPSBudWxsO1xyXG4gIHByaXZhdGUgX3dzczogV2ViU29ja2V0U2VydmVyID0gbnVsbDtcclxuICBwdWJsaWMgY2I6IEludGVyY2VwdG9yO1xyXG4gIHB1YmxpYyByZWFkb25seSBvbmx5SW50ZXJjZXB0VGV4dEZpbGVzOiBib29sZWFuO1xyXG4gIHByaXZhdGUgX3N0YXNoID0gbmV3IE1hcDxzdHJpbmcsIFN0YXNoZWRJdGVtPigpO1xyXG4gIHByaXZhdGUgX3N0YXNoRmlsdGVyOiAodXJsOiBzdHJpbmcsIGl0ZW06IFN0YXNoZWRJdGVtKSA9PiBib29sZWFuID0gZGVmYXVsdFN0YXNoRmlsdGVyO1xyXG4gIHB1YmxpYyBnZXQgc3Rhc2hGaWx0ZXIoKTogKHVybDogc3RyaW5nLCBpdGVtOiBTdGFzaGVkSXRlbSkgPT4gYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gdGhpcy5fc3Rhc2hGaWx0ZXI7XHJcbiAgfVxyXG4gIHB1YmxpYyBzZXQgc3Rhc2hGaWx0ZXIodmFsdWU6ICh1cmw6IHN0cmluZywgaXRlbTogU3Rhc2hlZEl0ZW0pID0+IGJvb2xlYW4pIHtcclxuICAgIGlmICh0eXBlb2YodmFsdWUpID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICAgIHRoaXMuX3N0YXNoRmlsdGVyID0gdmFsdWU7XHJcbiAgICB9IGVsc2UgaWYgKHZhbHVlID09PSBudWxsKSB7XHJcbiAgICAgIHRoaXMuX3N0YXNoRmlsdGVyID0gZGVmYXVsdFN0YXNoRmlsdGVyO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIHN0YXNoIGZpbHRlcjogRXhwZWN0ZWQgYSBmdW5jdGlvbi5gKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIHByaXZhdGUgY29uc3RydWN0b3IoY2I6IEludGVyY2VwdG9yLCBvbmx5SW50ZXJjZXB0VGV4dEZpbGVzOiBib29sZWFuKSB7XHJcbiAgICB0aGlzLmNiID0gY2I7XHJcbiAgICB0aGlzLm9ubHlJbnRlcmNlcHRUZXh0RmlsZXMgPSBvbmx5SW50ZXJjZXB0VGV4dEZpbGVzO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBfaW5pdGlhbGl6ZVdTUyh3c3M6IFdlYlNvY2tldFNlcnZlcik6IHZvaWQge1xyXG4gICAgdGhpcy5fd3NzID0gd3NzO1xyXG4gICAgdGhpcy5fd3NzLm9uKCdjb25uZWN0aW9uJywgKHdzKSA9PiB7XHJcbiAgICAgIHdzLm9uKCdlcnJvcicsIChlKSA9PiB7XHJcbiAgICAgICAgaWYgKChlIGFzIGFueSkuY29kZSAhPT0gXCJFQ09OTlJFU0VUXCIpIHtcclxuICAgICAgICAgIGNvbnNvbGUubG9nKGBXZWJTb2NrZXQgZXJyb3I6ICR7ZX1gKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgICB3cy5vbignbWVzc2FnZScsIGFzeW5jIChtZXNzYWdlOiBCdWZmZXIpID0+IHtcclxuICAgICAgICBjb25zdCBvcmlnaW5hbCA9IEludGVyY2VwdGVkSFRUUE1lc3NhZ2UuRnJvbUJ1ZmZlcihtZXNzYWdlKTtcclxuICAgICAgICBjb25zdCBydiA9IHRoaXMuY2Iob3JpZ2luYWwpO1xyXG4gICAgICAgIGlmIChydiAmJiB0eXBlb2YocnYpID09PSAnb2JqZWN0JyAmJiBydi50aGVuKSB7XHJcbiAgICAgICAgICBhd2FpdCBydjtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gUmVtb3ZlIHRyYW5zZmVyLWVuY29kaW5nLiBXZSBkb24ndCBzdXBwb3J0IGNodW5rZWQuXHJcbiAgICAgICAgaWYgKHRoaXMuX3N0YXNoRW5hYmxlZCkge1xyXG4gICAgICAgICAgY29uc3QgaXRlbSA9IG5ldyBTdGFzaGVkSXRlbShvcmlnaW5hbC5yZXF1ZXN0LnJhd1VybCwgb3JpZ2luYWwucmVzcG9uc2UuZ2V0SGVhZGVyKCdjb250ZW50LXR5cGUnKSwgb3JpZ2luYWwucmVzcG9uc2VCb2R5KTtcclxuICAgICAgICAgIGlmICh0aGlzLl9zdGFzaEZpbHRlcihvcmlnaW5hbC5yZXF1ZXN0LnJhd1VybCwgaXRlbSkpIHtcclxuICAgICAgICAgICAgdGhpcy5fc3Rhc2guc2V0KG9yaWdpbmFsLnJlcXVlc3QucmF3VXJsLCBpdGVtKTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgd3Muc2VuZChvcmlnaW5hbC50b0J1ZmZlcigpKTtcclxuICAgICAgfSk7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgX2luaXRpYWxpemVNSVRNUHJveHkobWl0bVByb3h5OiBDaGlsZFByb2Nlc3MpOiB2b2lkIHtcclxuICAgIHRoaXMuX21pdG1Qcm9jZXNzID0gbWl0bVByb3h5O1xyXG4gICAgdGhpcy5fbWl0bVByb2Nlc3Mub24oJ2V4aXQnLCAoY29kZSwgc2lnbmFsKSA9PiB7XHJcbiAgICAgIGNvbnN0IGluZGV4ID0gTUlUTVByb3h5Ll9hY3RpdmVQcm9jZXNzZXMuaW5kZXhPZih0aGlzLl9taXRtUHJvY2Vzcyk7XHJcbiAgICAgIGlmIChpbmRleCAhPT0gLTEpIHtcclxuICAgICAgICBNSVRNUHJveHkuX2FjdGl2ZVByb2Nlc3Nlcy5zcGxpY2UoaW5kZXgsIDEpO1xyXG4gICAgICB9XHJcbiAgICAgIGlmIChjb2RlICE9PSBudWxsKSB7XHJcbiAgICAgICAgaWYgKGNvZGUgIT09IDApIHtcclxuICAgICAgICAgIHRoaXMuX21pdG1FcnJvciA9IG5ldyBFcnJvcihgUHJvY2VzcyBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX0uYCk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIHRoaXMuX21pdG1FcnJvciA9IG5ldyBFcnJvcihgUHJvY2VzcyBleGl0ZWQgZHVlIHRvIHNpZ25hbCAke3NpZ25hbH0uYCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgdGhpcy5fbWl0bVByb2Nlc3Mub24oJ2Vycm9yJywgKGVycikgPT4ge1xyXG4gICAgICB0aGlzLl9taXRtRXJyb3IgPSBlcnI7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFJldHJpZXZlcyB0aGUgZ2l2ZW4gVVJMIGZyb20gdGhlIHN0YXNoLlxyXG4gICAqIEBwYXJhbSB1cmxcclxuICAgKi9cclxuICBwdWJsaWMgZ2V0RnJvbVN0YXNoKHVybDogc3RyaW5nKTogU3Rhc2hlZEl0ZW0ge1xyXG4gICAgcmV0dXJuIHRoaXMuX3N0YXNoLmdldCh1cmwpO1xyXG4gIH1cclxuXHJcbiAgcHVibGljIGZvckVhY2hTdGFzaEl0ZW0oY2I6ICh2YWx1ZTogU3Rhc2hlZEl0ZW0sIHVybDogc3RyaW5nKSA9PiB2b2lkKTogdm9pZCB7XHJcbiAgICB0aGlzLl9zdGFzaC5mb3JFYWNoKGNiKTtcclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFJlcXVlc3RzIHRoZSBnaXZlbiBVUkwgZnJvbSB0aGUgcHJveHkuXHJcbiAgICovXHJcbiAgcHVibGljIGFzeW5jIHByb3h5R2V0KHVybFN0cmluZzogc3RyaW5nKTogUHJvbWlzZTxIVFRQUmVzcG9uc2U+IHtcclxuICAgIGNvbnN0IHVybCA9IHBhcnNlVVJMKHVybFN0cmluZyk7XHJcbiAgICBjb25zdCBnZXQgPSB1cmwucHJvdG9jb2wgPT09IFwiaHR0cDpcIiA/IGh0dHBHZXQgOiBodHRwc0dldDtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIVFRQUmVzcG9uc2U+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgY29uc3QgcmVxID0gZ2V0KHtcclxuICAgICAgICB1cmw6IHVybFN0cmluZyxcclxuICAgICAgICBoZWFkZXJzOiB7XHJcbiAgICAgICAgICBob3N0OiB1cmwuaG9zdFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgaG9zdDogJ2xvY2FsaG9zdCcsXHJcbiAgICAgICAgcG9ydDogODA4MCxcclxuICAgICAgICBwYXRoOiB1cmxTdHJpbmdcclxuICAgICAgfSwgKHJlcykgPT4ge1xyXG4gICAgICAgIGNvbnN0IGRhdGEgPSBuZXcgQXJyYXk8QnVmZmVyPigpO1xyXG4gICAgICAgIHJlcy5vbignZGF0YScsIChjaHVuazogQnVmZmVyKSA9PiB7XHJcbiAgICAgICAgICBkYXRhLnB1c2goY2h1bmspO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJlcy5vbignZW5kJywgKCkgPT4ge1xyXG4gICAgICAgICAgY29uc3QgZCA9IEJ1ZmZlci5jb25jYXQoZGF0YSk7XHJcbiAgICAgICAgICByZXNvbHZlKHtcclxuICAgICAgICAgICAgc3RhdHVzQ29kZTogcmVzLnN0YXR1c0NvZGUsXHJcbiAgICAgICAgICAgIGhlYWRlcnM6IHJlcy5oZWFkZXJzLFxyXG4gICAgICAgICAgICBib2R5OiBkXHJcbiAgICAgICAgICB9IGFzIEhUVFBSZXNwb25zZSk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmVzLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgICAgfSk7XHJcbiAgICAgIHJlcS5vbmNlKCdlcnJvcicsIHJlamVjdCk7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIHB1YmxpYyBhc3luYyBzaHV0ZG93bigpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgIGNvbnN0IGNsb3NlV1NTID0gKCkgPT4ge1xyXG4gICAgICAgIHRoaXMuX3dzcy5jbG9zZSgoZXJyKSA9PiB7XHJcbiAgICAgICAgICBpZiAoZXJyKSB7XHJcbiAgICAgICAgICAgIHJlamVjdChlcnIpO1xyXG4gICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgcmVzb2x2ZSgpO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG4gICAgICB9O1xyXG5cclxuICAgICAgaWYgKHRoaXMuX21pdG1Qcm9jZXNzICYmICF0aGlzLl9taXRtUHJvY2Vzcy5raWxsZWQpIHtcclxuICAgICAgICB0aGlzLl9taXRtUHJvY2Vzcy5vbmNlKCdleGl0JywgKGNvZGUsIHNpZ25hbCkgPT4ge1xyXG4gICAgICAgICAgY2xvc2VXU1MoKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICB0aGlzLl9taXRtUHJvY2Vzcy5raWxsKCdTSUdURVJNJyk7XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgY2xvc2VXU1MoKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfVxyXG59XHJcbiJdfQ==