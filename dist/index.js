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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7OztBQUFBLDJCQUE2QztBQUM3QyxpREFBa0Q7QUFDbEQsK0JBQTZCO0FBQzdCLDZCQUEyQztBQUMzQywrQkFBb0M7QUFDcEMsaUNBQXNDO0FBQ3RDLDZCQUE2QztBQU83Qzs7Ozs7R0FLRztBQUNILHFCQUFxQixJQUFZLEVBQUUsVUFBa0IsRUFBRSxFQUFFLFdBQW1CLEdBQUc7SUFDN0UsTUFBTSxDQUFDLElBQUksT0FBTyxDQUFPLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1FBQzNDLElBQUksZ0JBQWdCLEdBQUcsT0FBTyxDQUFDO1FBQy9CLElBQUksYUFBYSxHQUFHLFFBQVEsQ0FBQztRQUM3QixJQUFJLEtBQUssR0FBaUIsSUFBSSxDQUFDO1FBQy9CLElBQUksTUFBTSxHQUFXLElBQUksQ0FBQztRQUUxQjtZQUNFLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNwQixLQUFLLEdBQUcsSUFBSSxDQUFDO1lBQ2IsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDO2dCQUFDLE1BQU0sQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUM3QixNQUFNLEdBQUcsSUFBSSxDQUFDO1FBQ2hCLENBQUM7UUFFRDtZQUNFLFlBQVksRUFBRSxDQUFDO1FBQ2pCLENBQUM7UUFFRDtZQUNFLDBCQUEwQixFQUFFLENBQUM7WUFFN0IsRUFBRSxDQUFDLENBQUMsRUFBRSxnQkFBZ0IsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUMzQixNQUFNLENBQUMsSUFBSSxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDO1lBQ3RDLENBQUM7WUFFRCxNQUFNLEdBQUcsc0JBQWdCLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRTtnQkFDM0MsMEJBQTBCLEVBQUUsQ0FBQztnQkFDN0IsRUFBRSxDQUFDLENBQUMsZ0JBQWdCLElB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dCB7U2VydmVyIGFzIFdlYlNvY2tldFNlcnZlcn0gZnJvbSAnd3MnO1xyXG5pbXBvcnQge3NwYXduLCBDaGlsZFByb2Nlc3N9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xyXG5pbXBvcnQge3Jlc29sdmV9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQge3BhcnNlIGFzIHBhcnNlVVJMLCBVcmx9IGZyb20gJ3VybCc7XHJcbmltcG9ydCB7Z2V0IGFzIGh0dHBHZXR9IGZyb20gJ2h0dHAnO1xyXG5pbXBvcnQge2dldCBhcyBodHRwc0dldH0gZnJvbSAnaHR0cHMnO1xyXG5pbXBvcnQge2NyZWF0ZUNvbm5lY3Rpb24sIFNvY2tldH0gZnJvbSAnbmV0JztcclxuaW50ZXJmYWNlIFByb2Nlc3Mge1xyXG4gIHBrZzogYm9vbGVhbixcclxuICBvbjogRnVuY3Rpb24sXHJcbiAgY3dkOiBGdW5jdGlvblxyXG59XHJcbmRlY2xhcmUgdmFyIHByb2Nlc3M6IFByb2Nlc3NcclxuLyoqXHJcbiAqIFdhaXQgZm9yIHRoZSBzcGVjaWZpZWQgcG9ydCB0byBvcGVuLlxyXG4gKiBAcGFyYW0gcG9ydCBUaGUgcG9ydCB0byB3YXRjaCBmb3IuXHJcbiAqIEBwYXJhbSByZXRyaWVzIFRoZSBudW1iZXIgb2YgdGltZXMgdG8gcmV0cnkgYmVmb3JlIGdpdmluZyB1cC4gRGVmYXVsdHMgdG8gMTAuXHJcbiAqIEBwYXJhbSBpbnRlcnZhbCBUaGUgaW50ZXJ2YWwgYmV0d2VlbiByZXRyaWVzLCBpbiBtaWxsaXNlY29uZHMuIERlZmF1bHRzIHRvIDUwMC5cclxuICovXHJcbmZ1bmN0aW9uIHdhaXRGb3JQb3J0KHBvcnQ6IG51bWJlciwgcmV0cmllczogbnVtYmVyID0gMTAsIGludGVydmFsOiBudW1iZXIgPSA1MDApOiBQcm9taXNlPHZvaWQ+IHtcclxuICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgbGV0IHJldHJpZXNSZW1haW5pbmcgPSByZXRyaWVzO1xyXG4gICAgbGV0IHJldHJ5SW50ZXJ2YWwgPSBpbnRlcnZhbDtcclxuICAgIGxldCB0aW1lcjogTm9kZUpTLlRpbWVyID0gbnVsbDtcclxuICAgIGxldCBzb2NrZXQ6IFNvY2tldCA9IG51bGw7XHJcblxyXG4gICAgZnVuY3Rpb24gY2xlYXJUaW1lckFuZERlc3Ryb3lTb2NrZXQoKSB7XHJcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XHJcbiAgICAgIHRpbWVyID0gbnVsbDtcclxuICAgICAgaWYgKHNvY2tldCkgc29ja2V0LmRlc3Ryb3koKTtcclxuICAgICAgc29ja2V0ID0gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICBmdW5jdGlvbiByZXRyeSgpIHtcclxuICAgICAgdHJ5VG9Db25uZWN0KCk7XHJcbiAgICB9XHJcblxyXG4gICAgZnVuY3Rpb24gdHJ5VG9Db25uZWN0KCkge1xyXG4gICAgICBjbGVhclRpbWVyQW5kRGVzdHJveVNvY2tldCgpO1xyXG5cclxuICAgICAgaWYgKC0tcmV0cmllc1JlbWFpbmluZyA8IDApIHtcclxuICAgICAgICByZWplY3QobmV3IEVycm9yKCdvdXQgb2YgcmV0cmllcycpKTtcclxuICAgICAgfVxyXG5cclxuICAgICAgc29ja2V0ID0gY3JlYXRlQ29ubmVjdGlvbihwb3J0LCBcImxvY2FsaG9zdFwiLCBmdW5jdGlvbigpIHtcclxuICAgICAgICBjbGVhclRpbWVyQW5kRGVzdHJveVNvY2tldCgpO1xyXG4gICAgICAgIGlmIChyZXRyaWVzUmVtYWluaW5nID49IDApIHJlc29sdmUoKTtcclxuICAgICAgfSk7XHJcblxyXG4gICAgICB0aW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7IHJldHJ5KCk7IH0sIHJldHJ5SW50ZXJ2YWwpO1xyXG5cclxuICAgICAgc29ja2V0Lm9uKCdlcnJvcicsIGZ1bmN0aW9uKGVycikge1xyXG4gICAgICAgIGNsZWFyVGltZXJBbmREZXN0cm95U29ja2V0KCk7XHJcbiAgICAgICAgc2V0VGltZW91dChyZXRyeSwgcmV0cnlJbnRlcnZhbCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIHRyeVRvQ29ubmVjdCgpO1xyXG4gIH0pO1xyXG59XHJcblxyXG4vKipcclxuICogRnVuY3Rpb24gdGhhdCBpbnRlcmNlcHRzIGFuZCByZXdyaXRlcyBIVFRQIHJlc3BvbnNlcy5cclxuICovXHJcbmV4cG9ydCB0eXBlIEludGVyY2VwdG9yID0gKG06IEludGVyY2VwdGVkSFRUUE1lc3NhZ2UpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xyXG5cclxuLyoqXHJcbiAqIEFuIGludGVyY2VwdG9yIHRoYXQgZG9lcyBub3RoaW5nLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG5vcEludGVyY2VwdG9yKG06IEludGVyY2VwdGVkSFRUUE1lc3NhZ2UpOiB2b2lkIHt9XHJcblxyXG4vKipcclxuICogVGhlIGNvcmUgSFRUUCByZXNwb25zZS5cclxuICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgSFRUUFJlc3BvbnNlIHtcclxuICBzdGF0dXNDb2RlOiBudW1iZXIsXHJcbiAgaGVhZGVyczoge1tuYW1lOiBzdHJpbmddOiBzdHJpbmd9O1xyXG4gIGJvZHk6IEJ1ZmZlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1ldGFkYXRhIGFzc29jaWF0ZWQgd2l0aCBhIHJlcXVlc3QvcmVzcG9uc2UgcGFpci5cclxuICovXHJcbmludGVyZmFjZSBIVFRQTWVzc2FnZU1ldGFkYXRhIHtcclxuICByZXF1ZXN0OiBIVFRQUmVxdWVzdE1ldGFkYXRhO1xyXG4gIHJlc3BvbnNlOiBIVFRQUmVzcG9uc2VNZXRhZGF0YTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1ldGFkYXRhIGFzc29jaWF0ZWQgd2l0aCBhbiBIVFRQIHJlcXVlc3QuXHJcbiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIEhUVFBSZXF1ZXN0TWV0YWRhdGEge1xyXG4gIC8vIEdFVCwgREVMRVRFLCBQT1NULCAgZXRjLlxyXG4gIG1ldGhvZDogc3RyaW5nO1xyXG4gIC8vIFRhcmdldCBVUkwgZm9yIHRoZSByZXF1ZXN0LlxyXG4gIHVybDogc3RyaW5nO1xyXG4gIC8vIFRoZSBzZXQgb2YgaGVhZGVycyBmcm9tIHRoZSByZXF1ZXN0LCBhcyBrZXktdmFsdWUgcGFpcnMuXHJcbiAgLy8gU2luY2UgaGVhZGVyIGZpZWxkcyBtYXkgYmUgcmVwZWF0ZWQsIHRoaXMgYXJyYXkgbWF5IGNvbnRhaW4gbXVsdGlwbGUgZW50cmllcyBmb3IgdGhlIHNhbWUga2V5LlxyXG4gIGhlYWRlcnM6IFtzdHJpbmcsIHN0cmluZ11bXTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1ldGFkYXRhIGFzc29jaWF0ZWQgd2l0aCBhbiBIVFRQIHJlc3BvbnNlLlxyXG4gKi9cclxuZXhwb3J0IGludGVyZmFjZSBIVFRQUmVzcG9uc2VNZXRhZGF0YSB7XHJcbiAgLy8gVGhlIG51bWVyaWNhbCBzdGF0dXMgY29kZS5cclxuICBzdGF0dXNfY29kZTogbnVtYmVyO1xyXG4gIC8vIFRoZSBzZXQgb2YgaGVhZGVycyBmcm9tIHRoZSByZXNwb25zZSwgYXMga2V5LXZhbHVlIHBhaXJzLlxyXG4gIC8vIFNpbmNlIGhlYWRlciBmaWVsZHMgbWF5IGJlIHJlcGVhdGVkLCB0aGlzIGFycmF5IG1heSBjb250YWluIG11bHRpcGxlIGVudHJpZXMgZm9yIHRoZSBzYW1lIGtleS5cclxuICBoZWFkZXJzOiBbc3RyaW5nLCBzdHJpbmddW107XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBBYnN0cmFjdCBjbGFzcyB0aGF0IHJlcHJlc2VudHMgSFRUUCBoZWFkZXJzLlxyXG4gKi9cclxuZXhwb3J0IGFic3RyYWN0IGNsYXNzIEFic3RyYWN0SFRUUEhlYWRlcnMge1xyXG4gIHByaXZhdGUgX2hlYWRlcnM6IFtzdHJpbmcsIHN0cmluZ11bXTtcclxuICAvLyBUaGUgcmF3IGhlYWRlcnMsIGFzIGEgc2VxdWVuY2Ugb2Yga2V5L3ZhbHVlIHBhaXJzLlxyXG4gIC8vIFNpbmNlIGhlYWRlciBmaWVsZHMgbWF5IGJlIHJlcGVhdGVkLCB0aGlzIGFycmF5IG1heSBjb250YWluIG11bHRpcGxlIGVudHJpZXMgZm9yIHRoZSBzYW1lIGtleS5cclxuICBwdWJsaWMgZ2V0IGhlYWRlcnMoKTogW3N0cmluZywgc3RyaW5nXVtdIHtcclxuICAgIHJldHVybiB0aGlzLl9oZWFkZXJzO1xyXG4gIH1cclxuICBjb25zdHJ1Y3RvcihoZWFkZXJzOiBbc3RyaW5nLCBzdHJpbmddW10pIHtcclxuICAgIHRoaXMuX2hlYWRlcnMgPSBoZWFkZXJzO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBfaW5kZXhPZkhlYWRlcihuYW1lOiBzdHJpbmcpOiBudW1iZXIge1xyXG4gICAgY29uc3QgaGVhZGVycyA9IHRoaXMuaGVhZGVycztcclxuICAgIGNvbnN0IGxlbiA9IGhlYWRlcnMubGVuZ3RoO1xyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBsZW47IGkrKykge1xyXG4gICAgICBpZiAoaGVhZGVyc1tpXVswXS50b0xvd2VyQ2FzZSgpID09PSBuYW1lKSB7XHJcbiAgICAgICAgcmV0dXJuIGk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiAtMTtcclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIEdldCB0aGUgdmFsdWUgb2YgdGhlIGdpdmVuIGhlYWRlciBmaWVsZC5cclxuICAgKiBJZiB0aGVyZSBhcmUgbXVsdGlwbGUgZmllbGRzIHdpdGggdGhhdCBuYW1lLCB0aGlzIG9ubHkgcmV0dXJucyB0aGUgZmlyc3QgZmllbGQncyB2YWx1ZSFcclxuICAgKiBAcGFyYW0gbmFtZSBOYW1lIG9mIHRoZSBoZWFkZXIgZmllbGRcclxuICAgKi9cclxuICBwdWJsaWMgZ2V0SGVhZGVyKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBpbmRleCA9IHRoaXMuX2luZGV4T2ZIZWFkZXIobmFtZS50b0xvd2VyQ2FzZSgpKTtcclxuICAgIGlmIChpbmRleCAhPT0gLTEpIHtcclxuICAgICAgcmV0dXJuIHRoaXMuaGVhZGVyc1tpbmRleF1bMV07XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJyc7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBTZXQgdGhlIHZhbHVlIG9mIHRoZSBnaXZlbiBoZWFkZXIgZmllbGQuIEFzc3VtZXMgdGhhdCB0aGVyZSBpcyBvbmx5IG9uZSBmaWVsZCB3aXRoIHRoZSBnaXZlbiBuYW1lLlxyXG4gICAqIElmIHRoZSBmaWVsZCBkb2VzIG5vdCBleGlzdCwgaXQgYWRkcyBhIG5ldyBmaWVsZCB3aXRoIHRoZSBuYW1lIGFuZCB2YWx1ZS5cclxuICAgKiBAcGFyYW0gbmFtZSBOYW1lIG9mIHRoZSBmaWVsZC5cclxuICAgKiBAcGFyYW0gdmFsdWUgTmV3IHZhbHVlLlxyXG4gICAqL1xyXG4gIHB1YmxpYyBzZXRIZWFkZXIobmFtZTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZCB7XHJcbiAgICBjb25zdCBpbmRleCA9IHRoaXMuX2luZGV4T2ZIZWFkZXIobmFtZS50b0xvd2VyQ2FzZSgpKTtcclxuICAgIGlmIChpbmRleCAhPT0gLTEpIHtcclxuICAgICAgdGhpcy5oZWFkZXJzW2luZGV4XVsxXSA9IHZhbHVlO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdGhpcy5oZWFkZXJzLnB1c2goW25hbWUsIHZhbHVlXSk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBSZW1vdmVzIHRoZSBoZWFkZXIgZmllbGQgd2l0aCB0aGUgZ2l2ZW4gbmFtZS4gQXNzdW1lcyB0aGF0IHRoZXJlIGlzIG9ubHkgb25lIGZpZWxkIHdpdGggdGhlIGdpdmVuIG5hbWUuXHJcbiAgICogRG9lcyBub3RoaW5nIGlmIGZpZWxkIGRvZXMgbm90IGV4aXN0LlxyXG4gICAqIEBwYXJhbSBuYW1lIE5hbWUgb2YgdGhlIGZpZWxkLlxyXG4gICAqL1xyXG4gIHB1YmxpYyByZW1vdmVIZWFkZXIobmFtZTogc3RyaW5nKTogdm9pZCB7XHJcbiAgICBjb25zdCBpbmRleCA9IHRoaXMuX2luZGV4T2ZIZWFkZXIobmFtZS50b0xvd2VyQ2FzZSgpKTtcclxuICAgIGlmIChpbmRleCAhPT0gLTEpIHtcclxuICAgICAgdGhpcy5oZWFkZXJzLnNwbGljZShpbmRleCwgMSk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBSZW1vdmVzIGFsbCBoZWFkZXIgZmllbGRzLlxyXG4gICAqL1xyXG4gIHB1YmxpYyBjbGVhckhlYWRlcnMoKTogdm9pZCB7XHJcbiAgICB0aGlzLl9oZWFkZXJzID0gW107XHJcbiAgfVxyXG59XHJcblxyXG4vKipcclxuICogUmVwcmVzZW50cyBhIE1JVE0tZWQgSFRUUCByZXNwb25zZSBmcm9tIGEgc2VydmVyLlxyXG4gKi9cclxuZXhwb3J0IGNsYXNzIEludGVyY2VwdGVkSFRUUFJlc3BvbnNlIGV4dGVuZHMgQWJzdHJhY3RIVFRQSGVhZGVycyB7XHJcbiAgLy8gVGhlIHN0YXR1cyBjb2RlIG9mIHRoZSBIVFRQIHJlc3BvbnNlLlxyXG4gIHB1YmxpYyBzdGF0dXNDb2RlOiBudW1iZXI7XHJcblxyXG4gIGNvbnN0cnVjdG9yKG1ldGFkYXRhOiBIVFRQUmVzcG9uc2VNZXRhZGF0YSkge1xyXG4gICAgc3VwZXIobWV0YWRhdGEuaGVhZGVycyk7XHJcbiAgICB0aGlzLnN0YXR1c0NvZGUgPSBtZXRhZGF0YS5zdGF0dXNfY29kZTtcclxuICAgIC8vIFdlIGRvbid0IHN1cHBvcnQgY2h1bmtlZCB0cmFuc2ZlcnMuIFRoZSBwcm94eSBhbHJlYWR5IGRlLWNodW5rcyBpdCBmb3IgdXMuXHJcbiAgICB0aGlzLnJlbW92ZUhlYWRlcigndHJhbnNmZXItZW5jb2RpbmcnKTtcclxuICAgIC8vIE1JVE1Qcm94eSBkZWNvZGVzIHRoZSBkYXRhIGZvciB1cy5cclxuICAgIHRoaXMucmVtb3ZlSGVhZGVyKCdjb250ZW50LWVuY29kaW5nJyk7XHJcbiAgICAvLyBDU1AgaXMgYmFkIVxyXG4gICAgdGhpcy5yZW1vdmVIZWFkZXIoJ2NvbnRlbnQtc2VjdXJpdHktcG9saWN5Jyk7XHJcbiAgICB0aGlzLnJlbW92ZUhlYWRlcigneC13ZWJraXQtY3NwJyk7XHJcbiAgICB0aGlzLnJlbW92ZUhlYWRlcigneC1jb250ZW50LXNlY3VyaXR5LXBvbGljeScpO1xyXG4gIH1cclxuXHJcbiAgcHVibGljIHRvSlNPTigpOiBIVFRQUmVzcG9uc2VNZXRhZGF0YSB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBzdGF0dXNfY29kZTogdGhpcy5zdGF0dXNDb2RlLFxyXG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnNcclxuICAgIH07XHJcbiAgfVxyXG59XHJcblxyXG4vKipcclxuICogUmVwcmVzZW50cyBhbiBpbnRlcmNlcHRlZCBIVFRQIHJlcXVlc3QgZnJvbSBhIGNsaWVudC5cclxuICovXHJcbmV4cG9ydCBjbGFzcyBJbnRlcmNlcHRlZEhUVFBSZXF1ZXN0IGV4dGVuZHMgQWJzdHJhY3RIVFRQSGVhZGVycyB7XHJcbiAgLy8gSFRUUCBtZXRob2QgKEdFVC9ERUxFVEUvZXRjKVxyXG4gIHB1YmxpYyBtZXRob2Q6IHN0cmluZztcclxuICAvLyBUaGUgVVJMIGFzIGEgc3RyaW5nLlxyXG4gIHB1YmxpYyByYXdVcmw6IHN0cmluZztcclxuICAvLyBUaGUgVVJMIGFzIGEgVVJMIG9iamVjdC5cclxuICBwdWJsaWMgdXJsOiBVcmw7XHJcblxyXG4gIGNvbnN0cnVjdG9yKG1ldGFkYXRhOiBIVFRQUmVxdWVzdE1ldGFkYXRhKSB7XHJcbiAgICBzdXBlcihtZXRhZGF0YS5oZWFkZXJzKTtcclxuICAgIHRoaXMubWV0aG9kID0gbWV0YWRhdGEubWV0aG9kLnRvTG93ZXJDYXNlKCk7XHJcbiAgICB0aGlzLnJhd1VybCA9IG1ldGFkYXRhLnVybDtcclxuICAgIHRoaXMudXJsID0gcGFyc2VVUkwodGhpcy5yYXdVcmwpO1xyXG4gIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFJlcHJlc2VudHMgYW4gaW50ZXJjZXB0ZWQgSFRUUCByZXF1ZXN0L3Jlc3BvbnNlIHBhaXIuXHJcbiAqL1xyXG5leHBvcnQgY2xhc3MgSW50ZXJjZXB0ZWRIVFRQTWVzc2FnZSB7XHJcbiAgLyoqXHJcbiAgICogVW5wYWNrIGZyb20gYSBCdWZmZXIgcmVjZWl2ZWQgZnJvbSBNSVRNUHJveHkuXHJcbiAgICogQHBhcmFtIGJcclxuICAgKi9cclxuICBwdWJsaWMgc3RhdGljIEZyb21CdWZmZXIoYjogQnVmZmVyKTogSW50ZXJjZXB0ZWRIVFRQTWVzc2FnZSB7XHJcbiAgICBjb25zdCBtZXRhZGF0YVNpemUgPSBiLnJlYWRJbnQzMkxFKDApO1xyXG4gICAgY29uc3QgcmVxdWVzdFNpemUgPSBiLnJlYWRJbnQzMkxFKDQpO1xyXG4gICAgY29uc3QgcmVzcG9uc2VTaXplID0gYi5yZWFkSW50MzJMRSg4KTtcclxuICAgIGNvbnN0IG1ldGFkYXRhOiBIVFRQTWVzc2FnZU1ldGFkYXRhID0gSlNPTi5wYXJzZShiLnRvU3RyaW5nKFwidXRmOFwiLCAxMiwgMTIgKyBtZXRhZGF0YVNpemUpKTtcclxuICAgIHJldHVybiBuZXcgSW50ZXJjZXB0ZWRIVFRQTWVzc2FnZShcclxuICAgICAgbmV3IEludGVyY2VwdGVkSFRUUFJlcXVlc3QobWV0YWRhdGEucmVxdWVzdCksXHJcbiAgICAgIG5ldyBJbnRlcmNlcHRlZEhUVFBSZXNwb25zZShtZXRhZGF0YS5yZXNwb25zZSksXHJcbiAgICAgIGIuc2xpY2UoMTIgKyBtZXRhZGF0YVNpemUsIDEyICsgbWV0YWRhdGFTaXplICsgcmVxdWVzdFNpemUpLFxyXG4gICAgICBiLnNsaWNlKDEyICsgbWV0YWRhdGFTaXplICsgcmVxdWVzdFNpemUsIDEyICsgbWV0YWRhdGFTaXplICsgcmVxdWVzdFNpemUgKyByZXNwb25zZVNpemUpXHJcbiAgICApO1xyXG4gIH1cclxuXHJcbiAgcHVibGljIHJlYWRvbmx5IHJlcXVlc3Q6IEludGVyY2VwdGVkSFRUUFJlcXVlc3Q7XHJcbiAgcHVibGljIHJlYWRvbmx5IHJlc3BvbnNlOiBJbnRlcmNlcHRlZEhUVFBSZXNwb25zZTtcclxuICAvLyBUaGUgYm9keSBvZiB0aGUgSFRUUCByZXF1ZXN0LlxyXG4gIHB1YmxpYyByZWFkb25seSByZXF1ZXN0Qm9keTogQnVmZmVyO1xyXG4gIC8vIFRoZSBib2R5IG9mIHRoZSBIVFRQIHJlc3BvbnNlLiBSZWFkLW9ubHk7IGNoYW5nZSB0aGUgcmVzcG9uc2UgYm9keSB2aWEgc2V0UmVzcG9uc2VCb2R5LlxyXG4gIHB1YmxpYyBnZXQgcmVzcG9uc2VCb2R5KCk6IEJ1ZmZlciB7XHJcbiAgICByZXR1cm4gdGhpcy5fcmVzcG9uc2VCb2R5O1xyXG4gIH1cclxuICBwcml2YXRlIF9yZXNwb25zZUJvZHk6IEJ1ZmZlcjtcclxuICBwcml2YXRlIGNvbnN0cnVjdG9yKHJlcXVlc3Q6IEludGVyY2VwdGVkSFRUUFJlcXVlc3QsIHJlc3BvbnNlOiBJbnRlcmNlcHRlZEhUVFBSZXNwb25zZSwgcmVxdWVzdEJvZHk6IEJ1ZmZlciwgcmVzcG9uc2VCb2R5OiBCdWZmZXIpIHtcclxuICAgIHRoaXMucmVxdWVzdCA9IHJlcXVlc3Q7XHJcbiAgICB0aGlzLnJlc3BvbnNlID0gcmVzcG9uc2U7XHJcbiAgICB0aGlzLnJlcXVlc3RCb2R5ID0gcmVxdWVzdEJvZHk7XHJcbiAgICB0aGlzLl9yZXNwb25zZUJvZHkgPSByZXNwb25zZUJvZHk7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBDaGFuZ2VzIHRoZSBib2R5IG9mIHRoZSBIVFRQIHJlc3BvbnNlLiBBcHByb3ByaWF0ZWx5IHVwZGF0ZXMgY29udGVudC1sZW5ndGguXHJcbiAgICogQHBhcmFtIGIgVGhlIG5ldyBib2R5IGNvbnRlbnRzLlxyXG4gICAqL1xyXG4gIHB1YmxpYyBzZXRSZXNwb25zZUJvZHkoYjogQnVmZmVyKSB7XHJcbiAgICB0aGlzLl9yZXNwb25zZUJvZHkgPSBiO1xyXG4gICAgLy8gVXBkYXRlIGNvbnRlbnQtbGVuZ3RoLlxyXG4gICAgdGhpcy5yZXNwb25zZS5zZXRIZWFkZXIoJ2NvbnRlbnQtbGVuZ3RoJywgYCR7Yi5sZW5ndGh9YCk7XHJcbiAgICAvLyBUT0RPOiBDb250ZW50LWVuY29kaW5nP1xyXG4gIH1cclxuICBcclxuICAvKipcclxuICAgKiBDaGFuZ2VzIHRoZSBzdGF0dXMgY29kZSBvZiB0aGUgSFRUUCByZXNwb25zZS5cclxuICAgKiBAcGFyYW0gY29kZSBUaGUgbmV3IHN0YXR1cyBjb2RlLlxyXG4gICAqL1xyXG4gIHB1YmxpYyBzZXRTdGF0dXNDb2RlKGNvZGU6IG51bWJlcikge1xyXG4gICAgdGhpcy5yZXNwb25zZS5zdGF0dXNDb2RlID0gY29kZTtcclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFBhY2sgaW50byBhIGJ1ZmZlciBmb3IgdHJhbnNtaXNzaW9uIHRvIE1JVE1Qcm94eS5cclxuICAgKi9cclxuICBwdWJsaWMgdG9CdWZmZXIoKTogQnVmZmVyIHtcclxuICAgIGNvbnN0IG1ldGFkYXRhID0gQnVmZmVyLmZyb20oSlNPTi5zdHJpbmdpZnkodGhpcy5yZXNwb25zZSksICd1dGY4Jyk7XHJcbiAgICBjb25zdCBtZXRhZGF0YUxlbmd0aCA9IG1ldGFkYXRhLmxlbmd0aDtcclxuICAgIGNvbnN0IHJlc3BvbnNlTGVuZ3RoID0gdGhpcy5fcmVzcG9uc2VCb2R5Lmxlbmd0aFxyXG4gICAgY29uc3QgcnYgPSBCdWZmZXIuYWxsb2MoOCArIG1ldGFkYXRhTGVuZ3RoICsgcmVzcG9uc2VMZW5ndGgpO1xyXG4gICAgcnYud3JpdGVJbnQzMkxFKG1ldGFkYXRhTGVuZ3RoLCAwKTtcclxuICAgIHJ2LndyaXRlSW50MzJMRShyZXNwb25zZUxlbmd0aCwgNCk7XHJcbiAgICBtZXRhZGF0YS5jb3B5KHJ2LCA4KTtcclxuICAgIHRoaXMuX3Jlc3BvbnNlQm9keS5jb3B5KHJ2LCA4ICsgbWV0YWRhdGFMZW5ndGgpO1xyXG4gICAgcmV0dXJuIHJ2O1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIFN0YXNoZWRJdGVtIHtcclxuICBjb25zdHJ1Y3RvcihcclxuICAgIHB1YmxpYyByZWFkb25seSByYXdVcmw6IHN0cmluZyxcclxuICAgIHB1YmxpYyByZWFkb25seSBtaW1lVHlwZTogc3RyaW5nLFxyXG4gICAgcHVibGljIHJlYWRvbmx5IGRhdGE6IEJ1ZmZlcikge31cclxuXHJcbiAgcHVibGljIGdldCBzaG9ydE1pbWVUeXBlKCk6IHN0cmluZyB7XHJcbiAgICBsZXQgbWltZSA9IHRoaXMubWltZVR5cGUudG9Mb3dlckNhc2UoKTtcclxuICAgIGlmIChtaW1lLmluZGV4T2YoXCI7XCIpICE9PSAtMSkge1xyXG4gICAgICBtaW1lID0gbWltZS5zbGljZSgwLCBtaW1lLmluZGV4T2YoXCI7XCIpKTtcclxuICAgIH1cclxuICAgIHJldHVybiBtaW1lO1xyXG4gIH1cclxuXHJcbiAgcHVibGljIGdldCBpc0h0bWwoKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gdGhpcy5zaG9ydE1pbWVUeXBlID09PSBcInRleHQvaHRtbFwiO1xyXG4gIH1cclxuXHJcbiAgcHVibGljIGdldCBpc0phdmFTY3JpcHQoKTogYm9vbGVhbiB7XHJcbiAgICBzd2l0Y2godGhpcy5zaG9ydE1pbWVUeXBlKSB7XHJcbiAgICAgIGNhc2UgJ3RleHQvamF2YXNjcmlwdCc6XHJcbiAgICAgIGNhc2UgJ2FwcGxpY2F0aW9uL2phdmFzY3JpcHQnOlxyXG4gICAgICBjYXNlICd0ZXh0L3gtamF2YXNjcmlwdCc6XHJcbiAgICAgIGNhc2UgJ2FwcGxpY2F0aW9uL3gtamF2YXNjcmlwdCc6XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVmYXVsdFN0YXNoRmlsdGVyKHVybDogc3RyaW5nLCBpdGVtOiBTdGFzaGVkSXRlbSk6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBpdGVtLmlzSmF2YVNjcmlwdCB8fCBpdGVtLmlzSHRtbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIENsYXNzIHRoYXQgbGF1bmNoZXMgTUlUTSBwcm94eSBhbmQgdGFsa3MgdG8gaXQgdmlhIFdlYlNvY2tldHMuXHJcbiAqL1xyXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBNSVRNUHJveHkge1xyXG4gIHByaXZhdGUgc3RhdGljIF9hY3RpdmVQcm9jZXNzZXM6IENoaWxkUHJvY2Vzc1tdID0gW107XHJcblxyXG4gIC8qKlxyXG4gICAqIENyZWF0ZXMgYSBuZXcgTUlUTVByb3h5IGluc3RhbmNlLlxyXG4gICAqIEBwYXJhbSBjYiBDYWxsZWQgd2l0aCBpbnRlcmNlcHRlZCBIVFRQIHJlcXVlc3RzIC8gcmVzcG9uc2VzLlxyXG4gICAqIEBwYXJhbSBpbnRlcmNlcHRQYXRocyBMaXN0IG9mIHBhdGhzIHRvIGNvbXBsZXRlbHkgaW50ZXJjZXB0IHdpdGhvdXQgc2VuZGluZyB0byB0aGUgc2VydmVyIChlLmcuIFsnL2V2YWwnXSlcclxuICAgKiBAcGFyYW0gcXVpZXQgSWYgdHJ1ZSwgZG8gbm90IHByaW50IGRlYnVnZ2luZyBtZXNzYWdlcyAoZGVmYXVsdHMgdG8gJ3RydWUnKS5cclxuICAgKiBAcGFyYW0gb25seUludGVyY2VwdFRleHRGaWxlcyBJZiB0cnVlLCBvbmx5IGludGVyY2VwdCB0ZXh0IGZpbGVzIChKYXZhU2NyaXB0L0hUTUwvQ1NTL2V0YywgYW5kIGlnbm9yZSBtZWRpYSBmaWxlcykuXHJcbiAgICovXHJcbiAgcHVibGljIHN0YXRpYyBhc3luYyBDcmVhdGUoY2I6IEludGVyY2VwdG9yID0gbm9wSW50ZXJjZXB0b3IsIGludGVyY2VwdFBhdGhzOiBzdHJpbmdbXSA9IFtdLCBxdWlldDogYm9vbGVhbiA9IHRydWUsIG9ubHlJbnRlcmNlcHRUZXh0RmlsZXMgPSBmYWxzZSwgaWdub3JlSG9zdHM6IHN0cmluZyB8IG51bGwgPSBudWxsKTogUHJvbWlzZTxNSVRNUHJveHk+IHtcclxuICAgIC8vIENvbnN0cnVjdCBXZWJTb2NrZXQgc2VydmVyLCBhbmQgd2FpdCBmb3IgaXQgdG8gYmVnaW4gbGlzdGVuaW5nLlxyXG4gICAgY29uc3Qgd3NzID0gbmV3IFdlYlNvY2tldFNlcnZlcih7IHBvcnQ6IDg3NjUgfSk7XHJcbiAgICBjb25zdCBwcm94eUNvbm5lY3RlZCA9IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgd3NzLm9uY2UoJ2Nvbm5lY3Rpb24nLCAoKSA9PiB7XHJcbiAgICAgICAgcmVzb2x2ZSgpO1xyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG4gICAgY29uc3QgbXAgPSBuZXcgTUlUTVByb3h5KGNiLCBvbmx5SW50ZXJjZXB0VGV4dEZpbGVzKTtcclxuICAgIC8vIFNldCB1cCBXU1MgY2FsbGJhY2tzIGJlZm9yZSBNSVRNUHJveHkgY29ubmVjdHMuXHJcbiAgICBtcC5faW5pdGlhbGl6ZVdTUyh3c3MpO1xyXG4gICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICB3c3Mub25jZSgnbGlzdGVuaW5nJywgKCkgPT4ge1xyXG4gICAgICAgIHdzcy5yZW1vdmVMaXN0ZW5lcignZXJyb3InLCByZWplY3QpO1xyXG4gICAgICAgIHJlc29sdmUoKTtcclxuICAgICAgfSk7XHJcbiAgICAgIHdzcy5vbmNlKCdlcnJvcicsIHJlamVjdCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0cnkge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3JQb3J0KDgwODAsIDEpO1xyXG4gICAgICAgIGlmICghcXVpZXQpIHtcclxuICAgICAgICAgIGNvbnNvbGUubG9nKGBNSVRNUHJveHkgYWxyZWFkeSBydW5uaW5nLmApO1xyXG4gICAgICAgIH1cclxuICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgIGlmICghcXVpZXQpIHtcclxuICAgICAgICAgIGNvbnNvbGUubG9nKGBNSVRNUHJveHkgbm90IHJ1bm5pbmc7IHN0YXJ0aW5nIHVwIG1pdG1wcm94eS5gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gU3RhcnQgdXAgTUlUTSBwcm9jZXNzLlxyXG4gICAgICAgIC8vIC0tYW50aWNhY2hlIG1lYW5zIHRvIGRpc2FibGUgY2FjaGluZywgd2hpY2ggZ2V0cyBpbiB0aGUgd2F5IG9mIHRyYW5zcGFyZW50bHkgcmV3cml0aW5nIGNvbnRlbnQuXHJcbiAgICAgICAgY29uc3Qgc2NyaXB0QXJncyA9IGludGVyY2VwdFBhdGhzLmxlbmd0aCA+IDAgPyBbXCItLXNldFwiLCBgaW50ZXJjZXB0PSR7aW50ZXJjZXB0UGF0aHMuam9pbihcIixcIil9YF0gOiBbXTtcclxuICAgICAgICBzY3JpcHRBcmdzLnB1c2goXCItLXNldFwiLCBgb25seUludGVyY2VwdFRleHRGaWxlcz0ke29ubHlJbnRlcmNlcHRUZXh0RmlsZXN9YCk7XHJcbiAgICAgICAgaWYgKGlnbm9yZUhvc3RzKSB7XHJcbiAgICAgICAgICBzY3JpcHRBcmdzLnB1c2goYC0taWdub3JlLWhvc3RzYCwgaWdub3JlSG9zdHMpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB2YXIgcGF0aCA9IChwcm9jZXNzLnBrZykgPyBwcm9jZXNzLmN3ZCgpIDogX19kaXJuYW1lO1xyXG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBbXCItLWFudGljYWNoZVwiLCBcIi1zXCIsIHJlc29sdmUocGF0aCwgYC4uL3NjcmlwdHMvcHJveHkucHlgKV0uY29uY2F0KHNjcmlwdEFyZ3MpO1xyXG4gICAgICAgIGlmIChxdWlldCkge1xyXG4gICAgICAgICAgb3B0aW9ucy5wdXNoKCctcScpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBcclxuICAgICAgICAvLyBhbGxvdyBzZWxmLXNpZ25lZCBTU0wgY2VydGlmaWNhdGVzXHJcbiAgICAgICAgb3B0aW9ucy5wdXNoKFwiLS1zc2wtaW5zZWN1cmVcIik7XHJcbiAgICAgICAgXHJcbiAgICAgICAgY29uc3QgbWl0bVByb2Nlc3MgPSBzcGF3bihcIm1pdG1kdW1wXCIsIG9wdGlvbnMsIHtcclxuICAgICAgICAgIHN0ZGlvOiAnaW5oZXJpdCdcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb25zdCBtaXRtUHJveHlFeGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigoXywgcmVqZWN0KSA9PiB7XHJcbiAgICAgICAgICBtaXRtUHJvY2Vzcy5vbmNlKCdlcnJvcicsIHJlamVjdCk7XHJcbiAgICAgICAgICBtaXRtUHJvY2Vzcy5vbmNlKCdleGl0JywgcmVqZWN0KTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoTUlUTVByb3h5Ll9hY3RpdmVQcm9jZXNzZXMucHVzaChtaXRtUHJvY2VzcykgPT09IDEpIHtcclxuICAgICAgICAgIHByb2Nlc3Mub24oJ1NJR0lOVCcsIE1JVE1Qcm94eS5fY2xlYW51cCk7XHJcbiAgICAgICAgICBwcm9jZXNzLm9uKCdleGl0JywgTUlUTVByb3h5Ll9jbGVhbnVwKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbXAuX2luaXRpYWxpemVNSVRNUHJveHkobWl0bVByb2Nlc3MpO1xyXG4gICAgICAgIC8vIFdhaXQgZm9yIHBvcnQgODA4MCB0byBjb21lIG9ubGluZS5cclxuICAgICAgICBjb25zdCB3YWl0aW5nRm9yUG9ydCA9IHdhaXRGb3JQb3J0KDgwODApO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAvLyBGYWlscyBpZiBtaXRtcHJveHkgZXhpdHMgYmVmb3JlIHBvcnQgYmVjb21lcyBhdmFpbGFibGUuXHJcbiAgICAgICAgICBhd2FpdCBQcm9taXNlLnJhY2UoW21pdG1Qcm94eUV4aXRlZCwgd2FpdGluZ0ZvclBvcnRdKTtcclxuICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICBpZiAoZSAmJiB0eXBlb2YoZSkgPT09ICdvYmplY3QnICYmIGUuY29kZSA9PT0gXCJFTk9FTlRcIikge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYG1pdG1kdW1wLCB3aGljaCBpcyBhbiBleGVjdXRhYmxlIHRoYXQgc2hpcHMgd2l0aCBtaXRtcHJveHksIGlzIG5vdCBvbiB5b3VyIFBBVEguIFBsZWFzZSBlbnN1cmUgdGhhdCB5b3UgY2FuIHJ1biBtaXRtZHVtcCAtLXZlcnNpb24gc3VjY2Vzc2Z1bGx5IGZyb20geW91ciBjb21tYW5kIGxpbmUuYClcclxuICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5hYmxlIHRvIHN0YXJ0IG1pdG1wcm94eTogJHtlfWApO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICBhd2FpdCBwcm94eUNvbm5lY3RlZDtcclxuICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgYXdhaXQgbmV3IFByb21pc2U8YW55PigocmVzb2x2ZSkgPT4gd3NzLmNsb3NlKHJlc29sdmUpKTtcclxuICAgICAgdGhyb3cgZTtcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gbXA7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIHN0YXRpYyBfY2xlYW51cENhbGxlZCA9IGZhbHNlO1xyXG4gIHByaXZhdGUgc3RhdGljIF9jbGVhbnVwKCk6IHZvaWQge1xyXG4gICAgaWYgKE1JVE1Qcm94eS5fY2xlYW51cENhbGxlZCkge1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBNSVRNUHJveHkuX2NsZWFudXBDYWxsZWQgPSB0cnVlO1xyXG4gICAgTUlUTVByb3h5Ll9hY3RpdmVQcm9jZXNzZXMuZm9yRWFjaCgocCkgPT4ge1xyXG4gICAgICBwLmtpbGwoJ1NJR0tJTEwnKTtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBfc3Rhc2hFbmFibGVkOiBib29sZWFuID0gZmFsc2U7XHJcbiAgLy8gVG9nZ2xlIHdoZXRoZXIgb3Igbm90IG1pdG1wcm94eS1ub2RlIHN0YXNoZXMgbW9kaWZpZWQgc2VydmVyIHJlc3BvbnNlcy5cclxuICAvLyAqKk5vdCB1c2VkIGZvciBwZXJmb3JtYW5jZSoqLCBidXQgZW5hYmxlcyBOb2RlLmpzIGNvZGUgdG8gZmV0Y2ggcHJldmlvdXMgc2VydmVyIHJlc3BvbnNlcyBmcm9tIHRoZSBwcm94eS5cclxuICBwdWJsaWMgZ2V0IHN0YXNoRW5hYmxlZCgpOiBib29sZWFuIHtcclxuICAgIHJldHVybiB0aGlzLl9zdGFzaEVuYWJsZWQ7XHJcbiAgfVxyXG4gIHB1YmxpYyBzZXQgc3Rhc2hFbmFibGVkKHY6IGJvb2xlYW4pIHtcclxuICAgIGlmICghdikge1xyXG4gICAgICB0aGlzLl9zdGFzaC5jbGVhcigpO1xyXG4gICAgfVxyXG4gICAgdGhpcy5fc3Rhc2hFbmFibGVkID0gdjtcclxuICB9XHJcbiAgcHJpdmF0ZSBfbWl0bVByb2Nlc3M6IENoaWxkUHJvY2VzcyA9IG51bGw7XHJcbiAgcHJpdmF0ZSBfbWl0bUVycm9yOiBFcnJvciA9IG51bGw7XHJcbiAgcHJpdmF0ZSBfd3NzOiBXZWJTb2NrZXRTZXJ2ZXIgPSBudWxsO1xyXG4gIHB1YmxpYyBjYjogSW50ZXJjZXB0b3I7XHJcbiAgcHVibGljIHJlYWRvbmx5IG9ubHlJbnRlcmNlcHRUZXh0RmlsZXM6IGJvb2xlYW47XHJcbiAgcHJpdmF0ZSBfc3Rhc2ggPSBuZXcgTWFwPHN0cmluZywgU3Rhc2hlZEl0ZW0+KCk7XHJcbiAgcHJpdmF0ZSBfc3Rhc2hGaWx0ZXI6ICh1cmw6IHN0cmluZywgaXRlbTogU3Rhc2hlZEl0ZW0pID0+IGJvb2xlYW4gPSBkZWZhdWx0U3Rhc2hGaWx0ZXI7XHJcbiAgcHVibGljIGdldCBzdGFzaEZpbHRlcigpOiAodXJsOiBzdHJpbmcsIGl0ZW06IFN0YXNoZWRJdGVtKSA9PiBib29sZWFuIHtcclxuICAgIHJldHVybiB0aGlzLl9zdGFzaEZpbHRlcjtcclxuICB9XHJcbiAgcHVibGljIHNldCBzdGFzaEZpbHRlcih2YWx1ZTogKHVybDogc3RyaW5nLCBpdGVtOiBTdGFzaGVkSXRlbSkgPT4gYm9vbGVhbikge1xyXG4gICAgaWYgKHR5cGVvZih2YWx1ZSkgPT09ICdmdW5jdGlvbicpIHtcclxuICAgICAgdGhpcy5fc3Rhc2hGaWx0ZXIgPSB2YWx1ZTtcclxuICAgIH0gZWxzZSBpZiAodmFsdWUgPT09IG51bGwpIHtcclxuICAgICAgdGhpcy5fc3Rhc2hGaWx0ZXIgPSBkZWZhdWx0U3Rhc2hGaWx0ZXI7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgc3Rhc2ggZmlsdGVyOiBFeHBlY3RlZCBhIGZ1bmN0aW9uLmApO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcihjYjogSW50ZXJjZXB0b3IsIG9ubHlJbnRlcmNlcHRUZXh0RmlsZXM6IGJvb2xlYW4pIHtcclxuICAgIHRoaXMuY2IgPSBjYjtcclxuICAgIHRoaXMub25seUludGVyY2VwdFRleHRGaWxlcyA9IG9ubHlJbnRlcmNlcHRUZXh0RmlsZXM7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIF9pbml0aWFsaXplV1NTKHdzczogV2ViU29ja2V0U2VydmVyKTogdm9pZCB7XHJcbiAgICB0aGlzLl93c3MgPSB3c3M7XHJcbiAgICB0aGlzLl93c3Mub24oJ2Nvbm5lY3Rpb24nLCAod3MpID0+IHtcclxuICAgICAgd3Mub24oJ2Vycm9yJywgKGUpID0+IHtcclxuICAgICAgICBpZiAoKGUgYXMgYW55KS5jb2RlICE9PSBcIkVDT05OUkVTRVRcIikge1xyXG4gICAgICAgICAgY29uc29sZS5sb2coYFdlYlNvY2tldCBlcnJvcjogJHtlfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgfSk7XHJcbiAgICAgIHdzLm9uKCdtZXNzYWdlJywgYXN5bmMgKG1lc3NhZ2U6IEJ1ZmZlcikgPT4ge1xyXG4gICAgICAgIGNvbnN0IG9yaWdpbmFsID0gSW50ZXJjZXB0ZWRIVFRQTWVzc2FnZS5Gcm9tQnVmZmVyKG1lc3NhZ2UpO1xyXG4gICAgICAgIGNvbnN0IHJ2ID0gdGhpcy5jYihvcmlnaW5hbCk7XHJcbiAgICAgICAgaWYgKHJ2ICYmIHR5cGVvZihydikgPT09ICdvYmplY3QnICYmIHJ2LnRoZW4pIHtcclxuICAgICAgICAgIGF3YWl0IHJ2O1xyXG4gICAgICAgIH1cclxuICAgICAgICAvLyBSZW1vdmUgdHJhbnNmZXItZW5jb2RpbmcuIFdlIGRvbid0IHN1cHBvcnQgY2h1bmtlZC5cclxuICAgICAgICBpZiAodGhpcy5fc3Rhc2hFbmFibGVkKSB7XHJcbiAgICAgICAgICBjb25zdCBpdGVtID0gbmV3IFN0YXNoZWRJdGVtKG9yaWdpbmFsLnJlcXVlc3QucmF3VXJsLCBvcmlnaW5hbC5yZXNwb25zZS5nZXRIZWFkZXIoJ2NvbnRlbnQtdHlwZScpLCBvcmlnaW5hbC5yZXNwb25zZUJvZHkpO1xyXG4gICAgICAgICAgaWYgKHRoaXMuX3N0YXNoRmlsdGVyKG9yaWdpbmFsLnJlcXVlc3QucmF3VXJsLCBpdGVtKSkge1xyXG4gICAgICAgICAgICB0aGlzLl9zdGFzaC5zZXQob3JpZ2luYWwucmVxdWVzdC5yYXdVcmwsIGl0ZW0pO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICB3cy5zZW5kKG9yaWdpbmFsLnRvQnVmZmVyKCkpO1xyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBfaW5pdGlhbGl6ZU1JVE1Qcm94eShtaXRtUHJveHk6IENoaWxkUHJvY2Vzcyk6IHZvaWQge1xyXG4gICAgdGhpcy5fbWl0bVByb2Nlc3MgPSBtaXRtUHJveHk7XHJcbiAgICB0aGlzLl9taXRtUHJvY2Vzcy5vbignZXhpdCcsIChjb2RlLCBzaWduYWwpID0+IHtcclxuICAgICAgY29uc3QgaW5kZXggPSBNSVRNUHJveHkuX2FjdGl2ZVByb2Nlc3Nlcy5pbmRleE9mKHRoaXMuX21pdG1Qcm9jZXNzKTtcclxuICAgICAgaWYgKGluZGV4ICE9PSAtMSkge1xyXG4gICAgICAgIE1JVE1Qcm94eS5fYWN0aXZlUHJvY2Vzc2VzLnNwbGljZShpbmRleCwgMSk7XHJcbiAgICAgIH1cclxuICAgICAgaWYgKGNvZGUgIT09IG51bGwpIHtcclxuICAgICAgICBpZiAoY29kZSAhPT0gMCkge1xyXG4gICAgICAgICAgdGhpcy5fbWl0bUVycm9yID0gbmV3IEVycm9yKGBQcm9jZXNzIGV4aXRlZCB3aXRoIGNvZGUgJHtjb2RlfS5gKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgdGhpcy5fbWl0bUVycm9yID0gbmV3IEVycm9yKGBQcm9jZXNzIGV4aXRlZCBkdWUgdG8gc2lnbmFsICR7c2lnbmFsfS5gKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICB0aGlzLl9taXRtUHJvY2Vzcy5vbignZXJyb3InLCAoZXJyKSA9PiB7XHJcbiAgICAgIHRoaXMuX21pdG1FcnJvciA9IGVycjtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogUmV0cmlldmVzIHRoZSBnaXZlbiBVUkwgZnJvbSB0aGUgc3Rhc2guXHJcbiAgICogQHBhcmFtIHVybFxyXG4gICAqL1xyXG4gIHB1YmxpYyBnZXRGcm9tU3Rhc2godXJsOiBzdHJpbmcpOiBTdGFzaGVkSXRlbSB7XHJcbiAgICByZXR1cm4gdGhpcy5fc3Rhc2guZ2V0KHVybCk7XHJcbiAgfVxyXG5cclxuICBwdWJsaWMgZm9yRWFjaFN0YXNoSXRlbShjYjogKHZhbHVlOiBTdGFzaGVkSXRlbSwgdXJsOiBzdHJpbmcpID0+IHZvaWQpOiB2b2lkIHtcclxuICAgIHRoaXMuX3N0YXNoLmZvckVhY2goY2IpO1xyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogUmVxdWVzdHMgdGhlIGdpdmVuIFVSTCBmcm9tIHRoZSBwcm94eS5cclxuICAgKi9cclxuICBwdWJsaWMgYXN5bmMgcHJveHlHZXQodXJsU3RyaW5nOiBzdHJpbmcpOiBQcm9taXNlPEhUVFBSZXNwb25zZT4ge1xyXG4gICAgY29uc3QgdXJsID0gcGFyc2VVUkwodXJsU3RyaW5nKTtcclxuICAgIGNvbnN0IGdldCA9IHVybC5wcm90b2NvbCA9PT0gXCJodHRwOlwiID8gaHR0cEdldCA6IGh0dHBzR2V0O1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPEhUVFBSZXNwb25zZT4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICBjb25zdCByZXEgPSBnZXQoe1xyXG4gICAgICAgIHVybDogdXJsU3RyaW5nLFxyXG4gICAgICAgIGhlYWRlcnM6IHtcclxuICAgICAgICAgIGhvc3Q6IHVybC5ob3N0XHJcbiAgICAgICAgfSxcclxuICAgICAgICBob3N0OiAnbG9jYWxob3N0JyxcclxuICAgICAgICBwb3J0OiA4MDgwLFxyXG4gICAgICAgIHBhdGg6IHVybFN0cmluZ1xyXG4gICAgICB9LCAocmVzKSA9PiB7XHJcbiAgICAgICAgY29uc3QgZGF0YSA9IG5ldyBBcnJheTxCdWZmZXI+KCk7XHJcbiAgICAgICAgcmVzLm9uKCdkYXRhJywgKGNodW5rOiBCdWZmZXIpID0+IHtcclxuICAgICAgICAgIGRhdGEucHVzaChjaHVuayk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmVzLm9uKCdlbmQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBjb25zdCBkID0gQnVmZmVyLmNvbmNhdChkYXRhKTtcclxuICAgICAgICAgIHJlc29sdmUoe1xyXG4gICAgICAgICAgICBzdGF0dXNDb2RlOiByZXMuc3RhdHVzQ29kZSxcclxuICAgICAgICAgICAgaGVhZGVyczogcmVzLmhlYWRlcnMsXHJcbiAgICAgICAgICAgIGJvZHk6IGRcclxuICAgICAgICAgIH0gYXMgSFRUUFJlc3BvbnNlKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXMub25jZSgnZXJyb3InLCByZWplY3QpO1xyXG4gICAgICB9KTtcclxuICAgICAgcmVxLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgcHVibGljIGFzeW5jIHNodXRkb3duKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgY29uc3QgY2xvc2VXU1MgPSAoKSA9PiB7XHJcbiAgICAgICAgdGhpcy5fd3NzLmNsb3NlKChlcnIpID0+IHtcclxuICAgICAgICAgIGlmIChlcnIpIHtcclxuICAgICAgICAgICAgcmVqZWN0KGVycik7XHJcbiAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICByZXNvbHZlKCk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH07XHJcblxyXG4gICAgICBpZiAodGhpcy5fbWl0bVByb2Nlc3MgJiYgIXRoaXMuX21pdG1Qcm9jZXNzLmtpbGxlZCkge1xyXG4gICAgICAgIHRoaXMuX21pdG1Qcm9jZXNzLm9uY2UoJ2V4aXQnLCAoY29kZSwgc2lnbmFsKSA9PiB7XHJcbiAgICAgICAgICBjbG9zZVdTUygpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRoaXMuX21pdG1Qcm9jZXNzLmtpbGwoJ1NJR1RFUk0nKTtcclxuICAgICAgfSBlbHNlIHtcclxuICAgICAgICBjbG9zZVdTUygpO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICB9XHJcbn1cclxuIl19