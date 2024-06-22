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
        // @ts-expect-error
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
     * @param ignoreHosts array of url as regex strings with ports to ignore.
     * @param allowHosts opposite of ignore hosts
     * @param exePath the path to the mitmdump.exe. default as "mitmdump" so must be in system path.
     * @param port set the port to run on. Default 8080.
     */
    static Create(cb = nopInterceptor, interceptPaths = [], quiet = true, onlyInterceptTextFiles = false, ignoreHosts = null, allowHosts = null, exePath = "mitmdump", port = 8080) {
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
                    yield waitForPort(port, 1);
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
                    scriptArgs.push("--listen-port", `${port}`);
                    if (ignoreHosts) {
                        for (let i = 0; i < ignoreHosts.length; i++) {
                            const host = ignoreHosts[i];
                            scriptArgs.push(`--ignore-hosts`, host);
                        }
                    }
                    if (allowHosts) {
                        for (let i = 0; i < allowHosts.length; i++) {
                            const host = allowHosts[i];
                            scriptArgs.push(`--allow-hosts`, host);
                        }
                    }
                    var path = (process.pkg) ? process.cwd() : __dirname;
                    const options = ["--anticache", "-s", path_1.resolve(path, `../scripts/proxy.py`)].concat(scriptArgs);
                    if (quiet) {
                        options.push('-q');
                    }
                    // allow self-signed SSL certificates
                    options.push("--ssl-insecure");
                    const mitmProcess = child_process_1.spawn(exePath, options, {
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
                    const waitingForPort = waitForPort(port);
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
    proxyGet(urlString, port = 8080) {
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
                    port: port,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7OztBQUFBLDJCQUE2QztBQUM3QyxpREFBa0Q7QUFDbEQsK0JBQTZCO0FBQzdCLDZCQUEyQztBQUMzQywrQkFBb0M7QUFDcEMsaUNBQXNDO0FBQ3RDLDZCQUE2QztBQU83Qzs7Ozs7R0FLRztBQUNILHFCQUFxQixJQUFZLEVBQUUsVUFBa0IsRUFBRSxFQUFFLFdBQW1CLEdBQUc7SUFDN0UsTUFBTSxDQUFDLElBQUksT0FBTyxDQUFPLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1FBQzNDLElBQUksZ0JBQWdCLEdBQUcsT0FBTyxDQUFDO1FBQy9CLElBQUksYUFBYSxHQUFHLFFBQVEsQ0FBQztRQUM3QixJQUFJLEtBQUssR0FBaUIsSUFBSSxDQUFDO1FBQy9CLElBQUksTUFBTSxHQUFXLElBQUksQ0FBQztRQUUxQjtZQUNFLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNwQixLQUFLLEdBQUcsSUFBSSxDQUFDO1lBQ2IsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDO2dCQUFDLE1BQU0sQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUM3QixNQUFNLEdBQUcsSUFBSSxDQUFDO1FBQ2hCLENBQUM7UUFFRDtZQUNFLFlBQVksRUFBRSxDQUFDO1FBQ2pCLENBQUM7UUFFRDtZQUNFLDBCQUEwQixFQUFFLENBQUM7WUFFN0IsRUFBRSxDQUFDLENBQUMsRUFBRSxnQkFBZ0IsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUMzQixNQUFNLENBQUMsSUFBSSxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDO1lBQ3RDLENBQUM7WUFFRCxNQUFNLEdBQUcsc0JBQWdCLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRTtnQkFDM0MsMEJBQTBCLEVBQUUsQ0FBQztnQkFDN0IsRUFBRSxDQUFDLENBQUMsZ0JBQWdCLElB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QyxLQUFLLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRTt3QkFDdEIsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQzs0QkFDUixNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7d0JBQ2QsQ0FBQzt3QkFBQyxJQUFJLENBQUMsQ0FBQzs0QkFDTixPQUFPLEVBQUUsQ0FBQzt3QkFDWixDQUFDO29CQUNILENBQUMsQ0FBQyxDQUFDO2dCQUNMLENBQUMsQ0FBQztnQkFFRixFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxJQUFJLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO29CQUNuRCxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLEVBQUU7d0JBQzlDLFFBQVEsRUFBRSxDQUFDO29CQUNiLENBQUMsQ0FBQyxDQUFDO29CQUNILElBQUksQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO2dCQUNwQyxDQUFDO2dCQUFDLElBQUksQ0FBQyxDQUFDO29CQUNOLFFBQVEsRUFBRSxDQUFDO2dCQUNiLENBQUM7WUFDSCxDQUFDLENBQUMsQ0FBQztRQUNMLENBQUM7S0FBQTs7QUFqUmMsMEJBQWdCLEdBQW1CLEVBQUUsQ0FBQztBQStHdEMsd0JBQWMsR0FBRyxLQUFLLENBQUM7QUFoSHhDLDRCQW1SQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7U2VydmVyIGFzIFdlYlNvY2tldFNlcnZlcn0gZnJvbSAnd3MnO1xyXG5pbXBvcnQge3NwYXduLCBDaGlsZFByb2Nlc3N9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xyXG5pbXBvcnQge3Jlc29sdmV9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQge3BhcnNlIGFzIHBhcnNlVVJMLCBVcmx9IGZyb20gJ3VybCc7XHJcbmltcG9ydCB7Z2V0IGFzIGh0dHBHZXR9IGZyb20gJ2h0dHAnO1xyXG5pbXBvcnQge2dldCBhcyBodHRwc0dldH0gZnJvbSAnaHR0cHMnO1xyXG5pbXBvcnQge2NyZWF0ZUNvbm5lY3Rpb24sIFNvY2tldH0gZnJvbSAnbmV0JztcclxuaW50ZXJmYWNlIFByb2Nlc3Mge1xyXG4gIHBrZzogYm9vbGVhbixcclxuICBvbjogRnVuY3Rpb24sXHJcbiAgY3dkOiBGdW5jdGlvblxyXG59XHJcbmRlY2xhcmUgdmFyIHByb2Nlc3M6IFByb2Nlc3NcclxuLyoqXHJcbiAqIFdhaXQgZm9yIHRoZSBzcGVjaWZpZWQgcG9ydCB0byBvcGVuLlxyXG4gKiBAcGFyYW0gcG9ydCBUaGUgcG9ydCB0byB3YXRjaCBmb3IuXHJcbiAqIEBwYXJhbSByZXRyaWVzIFRoZSBudW1iZXIgb2YgdGltZXMgdG8gcmV0cnkgYmVmb3JlIGdpdmluZyB1cC4gRGVmYXVsdHMgdG8gMTAuXHJcbiAqIEBwYXJhbSBpbnRlcnZhbCBUaGUgaW50ZXJ2YWwgYmV0d2VlbiByZXRyaWVzLCBpbiBtaWxsaXNlY29uZHMuIERlZmF1bHRzIHRvIDUwMC5cclxuICovXHJcbmZ1bmN0aW9uIHdhaXRGb3JQb3J0KHBvcnQ6IG51bWJlciwgcmV0cmllczogbnVtYmVyID0gMTAsIGludGVydmFsOiBudW1iZXIgPSA1MDApOiBQcm9taXNlPHZvaWQ+IHtcclxuICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgbGV0IHJldHJpZXNSZW1haW5pbmcgPSByZXRyaWVzO1xyXG4gICAgbGV0IHJldHJ5SW50ZXJ2YWwgPSBpbnRlcnZhbDtcclxuICAgIGxldCB0aW1lcjogTm9kZUpTLlRpbWVyID0gbnVsbDtcclxuICAgIGxldCBzb2NrZXQ6IFNvY2tldCA9IG51bGw7XHJcblxyXG4gICAgZnVuY3Rpb24gY2xlYXJUaW1lckFuZERlc3Ryb3lTb2NrZXQoKSB7XHJcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XHJcbiAgICAgIHRpbWVyID0gbnVsbDtcclxuICAgICAgaWYgKHNvY2tldCkgc29ja2V0LmRlc3Ryb3koKTtcclxuICAgICAgc29ja2V0ID0gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICBmdW5jdGlvbiByZXRyeSgpIHtcclxuICAgICAgdHJ5VG9Db25uZWN0KCk7XHJcbiAgICB9XHJcblxyXG4gICAgZnVuY3Rpb24gdHJ5VG9Db25uZWN0KCkge1xyXG4gICAgICBjbGVhclRpbWVyQW5kRGVzdHJveVNvY2tldCgpO1xyXG5cclxuICAgICAgaWYgKC0tcmV0cmllc1JlbWFpbmluZyA8IDApIHtcclxuICAgICAgICByZWplY3QobmV3IEVycm9yKCdvdXQgb2YgcmV0cmllcycpKTtcclxuICAgICAgfVxyXG5cclxuICAgICAgc29ja2V0ID0gY3JlYXRlQ29ubmVjdGlvbihwb3J0LCBcImxvY2FsaG9zdFwiLCBmdW5jdGlvbigpIHtcclxuICAgICAgICBjbGVhclRpbWVyQW5kRGVzdHJveVNvY2tldCgpO1xyXG4gICAgICAgIGlmIChyZXRyaWVzUmVtYWluaW5nID49IDApIHJlc29sdmUoKTtcclxuICAgICAgfSk7XHJcblxyXG4gICAgICB0aW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7IHJldHJ5KCk7IH0sIHJldHJ5SW50ZXJ2YWwpO1xyXG5cclxuICAgICAgc29ja2V0Lm9uKCdlcnJvcicsIGZ1bmN0aW9uKGVycikge1xyXG4gICAgICAgIGNsZWFyVGltZXJBbmREZXN0cm95U29ja2V0KCk7XHJcbiAgICAgICAgc2V0VGltZW91dChyZXRyeSwgcmV0cnlJbnRlcnZhbCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIHRyeVRvQ29ubmVjdCgpO1xyXG4gIH0pO1xyXG59XHJcblxyXG4vKipcclxuICogRnVuY3Rpb24gdGhhdCBpbnRlcmNlcHRzIGFuZCByZXdyaXRlcyBIVFRQIHJlc3BvbnNlcy5cclxuICovXHJcbmV4cG9ydCB0eXBlIEludGVyY2VwdG9yID0gKG06IEludGVyY2VwdGVkSFRUUE1lc3NhZ2UpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xyXG5cclxuLyoqXHJcbiAqIEFuIGludGVyY2VwdG9yIHRoYXQgZG9lcyBub3RoaW5nLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG5vcEludGVyY2VwdG9yKG06IEludGVyY2VwdGVkSFRUUE1lc3NhZ2UpOiB2b2lkIHt9XHJcblxyXG4vKipcclxuICogVGhlIGNvcmUgSFRUUCByZXNwb25zZS5cclxuICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgSFRUUFJlc3BvbnNlIHtcclxuICBzdGF0dXNDb2RlOiBudW1iZXIsXHJcbiAgaGVhZGVyczoge1tuYW1lOiBzdHJpbmddOiBzdHJpbmd9O1xyXG4gIGJvZHk6IEJ1ZmZlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1ldGFkYXRhIGFzc29jaWF0ZWQgd2l0aCBhIHJlcXVlc3QvcmVzcG9uc2UgcGFpci5cclxuICovXHJcbmludGVyZmFjZSBIVFRQTWVzc2FnZU1ldGFkYXRhIHtcclxuICByZXF1ZXN0OiBIVFRQUmVxdWVzdE1ldGFkYXRhO1xyXG4gIHJlc3BvbnNlOiBIVFRQUmVzcG9uc2VNZXRhZGF0YTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1ldGFkYXRhIGFzc29jaWF0ZWQgd2l0aCBhbiBIVFRQIHJlcXVlc3QuXHJcbiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIEhUVFBSZXF1ZXN0TWV0YWRhdGEge1xyXG4gIC8vIEdFVCwgREVMRVRFLCBQT1NULCAgZXRjLlxyXG4gIG1ldGhvZDogc3RyaW5nO1xyXG4gIC8vSVAgQWRkcmVzcyBvZiBDbGllbnRcclxuICBhZGRyZXNzOiBzdHJpbmc7XHJcbiAgLy9Qb3J0IG9mIENsaWVudFxyXG4gIHBvcnQ6IG51bWJlcjtcclxuICAvLyBUYXJnZXQgVVJMIGZvciB0aGUgcmVxdWVzdC5cclxuICB1cmw6IHN0cmluZztcclxuICAvLyBUaGUgc2V0IG9mIGhlYWRlcnMgZnJvbSB0aGUgcmVxdWVzdCwgYXMga2V5LXZhbHVlIHBhaXJzLlxyXG4gIC8vIFNpbmNlIGhlYWRlciBmaWVsZHMgbWF5IGJlIHJlcGVhdGVkLCB0aGlzIGFycmF5IG1heSBjb250YWluIG11bHRpcGxlIGVudHJpZXMgZm9yIHRoZSBzYW1lIGtleS5cclxuICBoZWFkZXJzOiBbc3RyaW5nLCBzdHJpbmddW107XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBNZXRhZGF0YSBhc3NvY2lhdGVkIHdpdGggYW4gSFRUUCByZXNwb25zZS5cclxuICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgSFRUUFJlc3BvbnNlTWV0YWRhdGEge1xyXG4gIC8vIFRoZSBudW1lcmljYWwgc3RhdHVzIGNvZGUuXHJcbiAgc3RhdHVzX2NvZGU6IG51bWJlcjtcclxuICAvLyBUaGUgc2V0IG9mIGhlYWRlcnMgZnJvbSB0aGUgcmVzcG9uc2UsIGFzIGtleS12YWx1ZSBwYWlycy5cclxuICAvLyBTaW5jZSBoZWFkZXIgZmllbGRzIG1heSBiZSByZXBlYXRlZCwgdGhpcyBhcnJheSBtYXkgY29udGFpbiBtdWx0aXBsZSBlbnRyaWVzIGZvciB0aGUgc2FtZSBrZXkuXHJcbiAgaGVhZGVyczogW3N0cmluZywgc3RyaW5nXVtdO1xyXG59XHJcblxyXG4vKipcclxuICogQWJzdHJhY3QgY2xhc3MgdGhhdCByZXByZXNlbnRzIEhUVFAgaGVhZGVycy5cclxuICovXHJcbmV4cG9ydCBhYnN0cmFjdCBjbGFzcyBBYnN0cmFjdEhUVFBIZWFkZXJzIHtcclxuICBwcml2YXRlIF9oZWFkZXJzOiBbc3RyaW5nLCBzdHJpbmddW107XHJcbiAgLy8gVGhlIHJhdyBoZWFkZXJzLCBhcyBhIHNlcXVlbmNlIG9mIGtleS92YWx1ZSBwYWlycy5cclxuICAvLyBTaW5jZSBoZWFkZXIgZmllbGRzIG1heSBiZSByZXBlYXRlZCwgdGhpcyBhcnJheSBtYXkgY29udGFpbiBtdWx0aXBsZSBlbnRyaWVzIGZvciB0aGUgc2FtZSBrZXkuXHJcbiAgcHVibGljIGdldCBoZWFkZXJzKCk6IFtzdHJpbmcsIHN0cmluZ11bXSB7XHJcbiAgICByZXR1cm4gdGhpcy5faGVhZGVycztcclxuICB9XHJcbiAgY29uc3RydWN0b3IoaGVhZGVyczogW3N0cmluZywgc3RyaW5nXVtdKSB7XHJcbiAgICB0aGlzLl9oZWFkZXJzID0gaGVhZGVycztcclxuICB9XHJcblxyXG4gIHByaXZhdGUgX2luZGV4T2ZIZWFkZXIobmFtZTogc3RyaW5nKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IGhlYWRlcnMgPSB0aGlzLmhlYWRlcnM7XHJcbiAgICBjb25zdCBsZW4gPSBoZWFkZXJzLmxlbmd0aDtcclxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbGVuOyBpKyspIHtcclxuICAgICAgaWYgKGhlYWRlcnNbaV1bMF0udG9Mb3dlckNhc2UoKSA9PT0gbmFtZSkge1xyXG4gICAgICAgIHJldHVybiBpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gLTE7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBHZXQgdGhlIHZhbHVlIG9mIHRoZSBnaXZlbiBoZWFkZXIgZmllbGQuXHJcbiAgICogSWYgdGhlcmUgYXJlIG11bHRpcGxlIGZpZWxkcyB3aXRoIHRoYXQgbmFtZSwgdGhpcyBvbmx5IHJldHVybnMgdGhlIGZpcnN0IGZpZWxkJ3MgdmFsdWUhXHJcbiAgICogQHBhcmFtIG5hbWUgTmFtZSBvZiB0aGUgaGVhZGVyIGZpZWxkXHJcbiAgICovXHJcbiAgcHVibGljIGdldEhlYWRlcihuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgaW5kZXggPSB0aGlzLl9pbmRleE9mSGVhZGVyKG5hbWUudG9Mb3dlckNhc2UoKSk7XHJcbiAgICBpZiAoaW5kZXggIT09IC0xKSB7XHJcbiAgICAgIHJldHVybiB0aGlzLmhlYWRlcnNbaW5kZXhdWzFdO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogU2V0IHRoZSB2YWx1ZSBvZiB0aGUgZ2l2ZW4gaGVhZGVyIGZpZWxkLiBBc3N1bWVzIHRoYXQgdGhlcmUgaXMgb25seSBvbmUgZmllbGQgd2l0aCB0aGUgZ2l2ZW4gbmFtZS5cclxuICAgKiBJZiB0aGUgZmllbGQgZG9lcyBub3QgZXhpc3QsIGl0IGFkZHMgYSBuZXcgZmllbGQgd2l0aCB0aGUgbmFtZSBhbmQgdmFsdWUuXHJcbiAgICogQHBhcmFtIG5hbWUgTmFtZSBvZiB0aGUgZmllbGQuXHJcbiAgICogQHBhcmFtIHZhbHVlIE5ldyB2YWx1ZS5cclxuICAgKi9cclxuICBwdWJsaWMgc2V0SGVhZGVyKG5hbWU6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQge1xyXG4gICAgY29uc3QgaW5kZXggPSB0aGlzLl9pbmRleE9mSGVhZGVyKG5hbWUudG9Mb3dlckNhc2UoKSk7XHJcbiAgICBpZiAoaW5kZXggIT09IC0xKSB7XHJcbiAgICAgIHRoaXMuaGVhZGVyc1tpbmRleF1bMV0gPSB2YWx1ZTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHRoaXMuaGVhZGVycy5wdXNoKFtuYW1lLCB2YWx1ZV0pO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogUmVtb3ZlcyB0aGUgaGVhZGVyIGZpZWxkIHdpdGggdGhlIGdpdmVuIG5hbWUuIEFzc3VtZXMgdGhhdCB0aGVyZSBpcyBvbmx5IG9uZSBmaWVsZCB3aXRoIHRoZSBnaXZlbiBuYW1lLlxyXG4gICAqIERvZXMgbm90aGluZyBpZiBmaWVsZCBkb2VzIG5vdCBleGlzdC5cclxuICAgKiBAcGFyYW0gbmFtZSBOYW1lIG9mIHRoZSBmaWVsZC5cclxuICAgKi9cclxuICBwdWJsaWMgcmVtb3ZlSGVhZGVyKG5hbWU6IHN0cmluZyk6IHZvaWQge1xyXG4gICAgY29uc3QgaW5kZXggPSB0aGlzLl9pbmRleE9mSGVhZGVyKG5hbWUudG9Mb3dlckNhc2UoKSk7XHJcbiAgICBpZiAoaW5kZXggIT09IC0xKSB7XHJcbiAgICAgIHRoaXMuaGVhZGVycy5zcGxpY2UoaW5kZXgsIDEpO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogUmVtb3ZlcyBhbGwgaGVhZGVyIGZpZWxkcy5cclxuICAgKi9cclxuICBwdWJsaWMgY2xlYXJIZWFkZXJzKCk6IHZvaWQge1xyXG4gICAgdGhpcy5faGVhZGVycyA9IFtdO1xyXG4gIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFJlcHJlc2VudHMgYSBNSVRNLWVkIEhUVFAgcmVzcG9uc2UgZnJvbSBhIHNlcnZlci5cclxuICovXHJcbmV4cG9ydCBjbGFzcyBJbnRlcmNlcHRlZEhUVFBSZXNwb25zZSBleHRlbmRzIEFic3RyYWN0SFRUUEhlYWRlcnMge1xyXG4gIC8vIFRoZSBzdGF0dXMgY29kZSBvZiB0aGUgSFRUUCByZXNwb25zZS5cclxuICBwdWJsaWMgc3RhdHVzQ29kZTogbnVtYmVyO1xyXG5cclxuICBjb25zdHJ1Y3RvcihtZXRhZGF0YTogSFRUUFJlc3BvbnNlTWV0YWRhdGEpIHtcclxuICAgIHN1cGVyKG1ldGFkYXRhLmhlYWRlcnMpO1xyXG4gICAgdGhpcy5zdGF0dXNDb2RlID0gbWV0YWRhdGEuc3RhdHVzX2NvZGU7XHJcbiAgICAvLyBXZSBkb24ndCBzdXBwb3J0IGNodW5rZWQgdHJhbnNmZXJzLiBUaGUgcHJveHkgYWxyZWFkeSBkZS1jaHVua3MgaXQgZm9yIHVzLlxyXG4gICAgdGhpcy5yZW1vdmVIZWFkZXIoJ3RyYW5zZmVyLWVuY29kaW5nJyk7XHJcbiAgICAvLyBNSVRNUHJveHkgZGVjb2RlcyB0aGUgZGF0YSBmb3IgdXMuXHJcbiAgICB0aGlzLnJlbW92ZUhlYWRlcignY29udGVudC1lbmNvZGluZycpO1xyXG4gICAgLy8gQ1NQIGlzIGJhZCFcclxuICAgIHRoaXMucmVtb3ZlSGVhZGVyKCdjb250ZW50LXNlY3VyaXR5LXBvbGljeScpO1xyXG4gICAgdGhpcy5yZW1vdmVIZWFkZXIoJ3gtd2Via2l0LWNzcCcpO1xyXG4gICAgdGhpcy5yZW1vdmVIZWFkZXIoJ3gtY29udGVudC1zZWN1cml0eS1wb2xpY3knKTtcclxuICB9XHJcblxyXG4gIHB1YmxpYyB0b0pTT04oKTogSFRUUFJlc3BvbnNlTWV0YWRhdGEge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgc3RhdHVzX2NvZGU6IHRoaXMuc3RhdHVzQ29kZSxcclxuICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzXHJcbiAgICB9O1xyXG4gIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFJlcHJlc2VudHMgYW4gaW50ZXJjZXB0ZWQgSFRUUCByZXF1ZXN0IGZyb20gYSBjbGllbnQuXHJcbiAqL1xyXG5leHBvcnQgY2xhc3MgSW50ZXJjZXB0ZWRIVFRQUmVxdWVzdCBleHRlbmRzIEFic3RyYWN0SFRUUEhlYWRlcnMge1xyXG4gIC8vIEhUVFAgbWV0aG9kIChHRVQvREVMRVRFL2V0YylcclxuICBwdWJsaWMgbWV0aG9kOiBzdHJpbmc7XHJcbiAgLy8gVGhlIFVSTCBhcyBhIHN0cmluZy5cclxuICBwdWJsaWMgcmF3VXJsOiBzdHJpbmc7XHJcbiAgLy8gVGhlIFVSTCBhcyBhIFVSTCBvYmplY3QuXHJcbiAgcHVibGljIHVybDogVXJsO1xyXG4gIC8vSVAgQWRkcmVzcyBvZiBDbGllbnRcclxuICBwdWJsaWMgYWRkcmVzczogc3RyaW5nO1xyXG4gIC8vUG9ydCBvZiBDbGllbnRcclxuICBwdWJsaWMgcG9ydDogbnVtYmVyO1xyXG5cclxuICBjb25zdHJ1Y3RvcihtZXRhZGF0YTogSFRUUFJlcXVlc3RNZXRhZGF0YSkge1xyXG4gICAgc3VwZXIobWV0YWRhdGEuaGVhZGVycyk7XHJcbiAgICB0aGlzLmFkZHJlc3MgPSBtZXRhZGF0YS5hZGRyZXNzO1xyXG4gICAgdGhpcy5wb3J0ID0gbWV0YWRhdGEucG9ydDtcclxuICAgIHRoaXMubWV0aG9kID0gbWV0YWRhdGEubWV0aG9kLnRvTG93ZXJDYXNlKCk7XHJcbiAgICB0aGlzLnJhd1VybCA9IG1ldGFkYXRhLnVybDtcclxuICAgIHRoaXMudXJsID0gcGFyc2VVUkwodGhpcy5yYXdVcmwpO1xyXG4gIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFJlcHJlc2VudHMgYW4gaW50ZXJjZXB0ZWQgSFRUUCByZXF1ZXN0L3Jlc3BvbnNlIHBhaXIuXHJcbiAqL1xyXG5leHBvcnQgY2xhc3MgSW50ZXJjZXB0ZWRIVFRQTWVzc2FnZSB7XHJcbiAgLyoqXHJcbiAgICogVW5wYWNrIGZyb20gYSBCdWZmZXIgcmVjZWl2ZWQgZnJvbSBNSVRNUHJveHkuXHJcbiAgICogQHBhcmFtIGJcclxuICAgKi9cclxuICBwdWJsaWMgc3RhdGljIEZyb21CdWZmZXIoYjogQnVmZmVyKTogSW50ZXJjZXB0ZWRIVFRQTWVzc2FnZSB7XHJcbiAgICBjb25zdCBtZXRhZGF0YVNpemUgPSBiLnJlYWRJbnQzMkxFKDApO1xyXG4gICAgY29uc3QgcmVxdWVzdFNpemUgPSBiLnJlYWRJbnQzMkxFKDQpO1xyXG4gICAgY29uc3QgcmVzcG9uc2VTaXplID0gYi5yZWFkSW50MzJMRSg4KTtcclxuICAgIGNvbnN0IG1ldGFkYXRhOiBIVFRQTWVzc2FnZU1ldGFkYXRhID0gSlNPTi5wYXJzZShiLnRvU3RyaW5nKFwidXRmOFwiLCAxMiwgMTIgKyBtZXRhZGF0YVNpemUpKTtcclxuICAgIHJldHVybiBuZXcgSW50ZXJjZXB0ZWRIVFRQTWVzc2FnZShcclxuICAgICAgbmV3IEludGVyY2VwdGVkSFRUUFJlcXVlc3QobWV0YWRhdGEucmVxdWVzdCksXHJcbiAgICAgIG5ldyBJbnRlcmNlcHRlZEhUVFBSZXNwb25zZShtZXRhZGF0YS5yZXNwb25zZSksXHJcbiAgICAgIGIuc2xpY2UoMTIgKyBtZXRhZGF0YVNpemUsIDEyICsgbWV0YWRhdGFTaXplICsgcmVxdWVzdFNpemUpLFxyXG4gICAgICBiLnNsaWNlKDEyICsgbWV0YWRhdGFTaXplICsgcmVxdWVzdFNpemUsIDEyICsgbWV0YWRhdGFTaXplICsgcmVxdWVzdFNpemUgKyByZXNwb25zZVNpemUpXHJcbiAgICApO1xyXG4gIH1cclxuXHJcbiAgcHVibGljIHJlYWRvbmx5IHJlcXVlc3Q6IEludGVyY2VwdGVkSFRUUFJlcXVlc3Q7XHJcbiAgcHVibGljIHJlYWRvbmx5IHJlc3BvbnNlOiBJbnRlcmNlcHRlZEhUVFBSZXNwb25zZTtcclxuICAvLyBUaGUgYm9keSBvZiB0aGUgSFRUUCByZXF1ZXN0LlxyXG4gIHB1YmxpYyByZWFkb25seSByZXF1ZXN0Qm9keTogQnVmZmVyO1xyXG4gIC8vIFRoZSBib2R5IG9mIHRoZSBIVFRQIHJlc3BvbnNlLiBSZWFkLW9ubHk7IGNoYW5nZSB0aGUgcmVzcG9uc2UgYm9keSB2aWEgc2V0UmVzcG9uc2VCb2R5LlxyXG4gIHB1YmxpYyBnZXQgcmVzcG9uc2VCb2R5KCk6IEJ1ZmZlciB7XHJcbiAgICByZXR1cm4gdGhpcy5fcmVzcG9uc2VCb2R5O1xyXG4gIH1cclxuICBwcml2YXRlIF9yZXNwb25zZUJvZHk6IEJ1ZmZlcjtcclxuICBwcml2YXRlIGNvbnN0cnVjdG9yKHJlcXVlc3Q6IEludGVyY2VwdGVkSFRUUFJlcXVlc3QsIHJlc3BvbnNlOiBJbnRlcmNlcHRlZEhUVFBSZXNwb25zZSwgcmVxdWVzdEJvZHk6IEJ1ZmZlciwgcmVzcG9uc2VCb2R5OiBCdWZmZXIpIHtcclxuICAgIHRoaXMucmVxdWVzdCA9IHJlcXVlc3Q7XHJcbiAgICB0aGlzLnJlc3BvbnNlID0gcmVzcG9uc2U7XHJcbiAgICB0aGlzLnJlcXVlc3RCb2R5ID0gcmVxdWVzdEJvZHk7XHJcbiAgICB0aGlzLl9yZXNwb25zZUJvZHkgPSByZXNwb25zZUJvZHk7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBDaGFuZ2VzIHRoZSBib2R5IG9mIHRoZSBIVFRQIHJlc3BvbnNlLiBBcHByb3ByaWF0ZWx5IHVwZGF0ZXMgY29udGVudC1sZW5ndGguXHJcbiAgICogQHBhcmFtIGIgVGhlIG5ldyBib2R5IGNvbnRlbnRzLlxyXG4gICAqL1xyXG4gIHB1YmxpYyBzZXRSZXNwb25zZUJvZHkoYjogQnVmZmVyKSB7XHJcbiAgICB0aGlzLl9yZXNwb25zZUJvZHkgPSBiO1xyXG4gICAgLy8gVXBkYXRlIGNvbnRlbnQtbGVuZ3RoLlxyXG4gICAgdGhpcy5yZXNwb25zZS5zZXRIZWFkZXIoJ2NvbnRlbnQtbGVuZ3RoJywgYCR7Yi5sZW5ndGh9YCk7XHJcbiAgICAvLyBUT0RPOiBDb250ZW50LWVuY29kaW5nP1xyXG4gIH1cclxuICBcclxuICAvKipcclxuICAgKiBDaGFuZ2VzIHRoZSBzdGF0dXMgY29kZSBvZiB0aGUgSFRUUCByZXNwb25zZS5cclxuICAgKiBAcGFyYW0gY29kZSBUaGUgbmV3IHN0YXR1cyBjb2RlLlxyXG4gICAqL1xyXG4gIHB1YmxpYyBzZXRTdGF0dXNDb2RlKGNvZGU6IG51bWJlcikge1xyXG4gICAgdGhpcy5yZXNwb25zZS5zdGF0dXNDb2RlID0gY29kZTtcclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFBhY2sgaW50byBhIGJ1ZmZlciBmb3IgdHJhbnNtaXNzaW9uIHRvIE1JVE1Qcm94eS5cclxuICAgKi9cclxuICBwdWJsaWMgdG9CdWZmZXIoKTogQnVmZmVyIHtcclxuICAgIGNvbnN0IG1ldGFkYXRhID0gQnVmZmVyLmZyb20oSlNPTi5zdHJpbmdpZnkodGhpcy5yZXNwb25zZSksICd1dGY4Jyk7XHJcbiAgICBjb25zdCBtZXRhZGF0YUxlbmd0aCA9IG1ldGFkYXRhLmxlbmd0aDtcclxuICAgIGNvbnN0IHJlc3BvbnNlTGVuZ3RoID0gdGhpcy5fcmVzcG9uc2VCb2R5Lmxlbmd0aFxyXG4gICAgY29uc3QgcnYgPSBCdWZmZXIuYWxsb2MoOCArIG1ldGFkYXRhTGVuZ3RoICsgcmVzcG9uc2VMZW5ndGgpO1xyXG4gICAgcnYud3JpdGVJbnQzMkxFKG1ldGFkYXRhTGVuZ3RoLCAwKTtcclxuICAgIHJ2LndyaXRlSW50MzJMRShyZXNwb25zZUxlbmd0aCwgNCk7XHJcbiAgICBtZXRhZGF0YS5jb3B5KHJ2LCA4KTtcclxuICAgIHRoaXMuX3Jlc3BvbnNlQm9keS5jb3B5KHJ2LCA4ICsgbWV0YWRhdGFMZW5ndGgpO1xyXG4gICAgcmV0dXJuIHJ2O1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIFN0YXNoZWRJdGVtIHtcclxuICBjb25zdHJ1Y3RvcihcclxuICAgIHB1YmxpYyByZWFkb25seSByYXdVcmw6IHN0cmluZyxcclxuICAgIHB1YmxpYyByZWFkb25seSBtaW1lVHlwZTogc3RyaW5nLFxyXG4gICAgcHVibGljIHJlYWRvbmx5IGRhdGE6IEJ1ZmZlcikge31cclxuXHJcbiAgcHVibGljIGdldCBzaG9ydE1pbWVUeXBlKCk6IHN0cmluZyB7XHJcbiAgICBsZXQgbWltZSA9IHRoaXMubWltZVR5cGUudG9Mb3dlckNhc2UoKTtcclxuICAgIGlmIChtaW1lLmluZGV4T2YoXCI7XCIpICE9PSAtMSkge1xyXG4gICAgICBtaW1lID0gbWltZS5zbGljZSgwLCBtaW1lLmluZGV4T2YoXCI7XCIpKTtcclxuICAgIH1cclxuICAgIHJldHVybiBtaW1lO1xyXG4gIH1cclxuXHJcbiAgcHVibGljIGdldCBpc0h0bWwoKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gdGhpcy5zaG9ydE1pbWVUeXBlID09PSBcInRleHQvaHRtbFwiO1xyXG4gIH1cclxuXHJcbiAgcHVibGljIGdldCBpc0phdmFTY3JpcHQoKTogYm9vbGVhbiB7XHJcbiAgICBzd2l0Y2godGhpcy5zaG9ydE1pbWVUeXBlKSB7XHJcbiAgICAgIGNhc2UgJ3RleHQvamF2YXNjcmlwdCc6XHJcbiAgICAgIGNhc2UgJ2FwcGxpY2F0aW9uL2phdmFzY3JpcHQnOlxyXG4gICAgICBjYXNlICd0ZXh0L3gtamF2YXNjcmlwdCc6XHJcbiAgICAgIGNhc2UgJ2FwcGxpY2F0aW9uL3gtamF2YXNjcmlwdCc6XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVmYXVsdFN0YXNoRmlsdGVyKHVybDogc3RyaW5nLCBpdGVtOiBTdGFzaGVkSXRlbSk6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBpdGVtLmlzSmF2YVNjcmlwdCB8fCBpdGVtLmlzSHRtbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIENsYXNzIHRoYXQgbGF1bmNoZXMgTUlUTSBwcm94eSBhbmQgdGFsa3MgdG8gaXQgdmlhIFdlYlNvY2tldHMuXHJcbiAqL1xyXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBNSVRNUHJveHkge1xyXG4gIHByaXZhdGUgc3RhdGljIF9hY3RpdmVQcm9jZXNzZXM6IENoaWxkUHJvY2Vzc1tdID0gW107XHJcblxyXG4gIC8qKlxyXG4gICAqIENyZWF0ZXMgYSBuZXcgTUlUTVByb3h5IGluc3RhbmNlLlxyXG4gICAqIEBwYXJhbSBjYiBDYWxsZWQgd2l0aCBpbnRlcmNlcHRlZCBIVFRQIHJlcXVlc3RzIC8gcmVzcG9uc2VzLlxyXG4gICAqIEBwYXJhbSBpbnRlcmNlcHRQYXRocyBMaXN0IG9mIHBhdGhzIHRvIGNvbXBsZXRlbHkgaW50ZXJjZXB0IHdpdGhvdXQgc2VuZGluZyB0byB0aGUgc2VydmVyIChlLmcuIFsnL2V2YWwnXSlcclxuICAgKiBAcGFyYW0gcXVpZXQgSWYgdHJ1ZSwgZG8gbm90IHByaW50IGRlYnVnZ2luZyBtZXNzYWdlcyAoZGVmYXVsdHMgdG8gJ3RydWUnKS5cclxuICAgKiBAcGFyYW0gb25seUludGVyY2VwdFRleHRGaWxlcyBJZiB0cnVlLCBvbmx5IGludGVyY2VwdCB0ZXh0IGZpbGVzIChKYXZhU2NyaXB0L0hUTUwvQ1NTL2V0YywgYW5kIGlnbm9yZSBtZWRpYSBmaWxlcykuXHJcbiAgICogQHBhcmFtIGlnbm9yZUhvc3RzIGFycmF5IG9mIHVybCBhcyByZWdleCBzdHJpbmdzIHdpdGggcG9ydHMgdG8gaWdub3JlLlxyXG4gICAqIEBwYXJhbSBhbGxvd0hvc3RzIG9wcG9zaXRlIG9mIGlnbm9yZSBob3N0c1xyXG4gICAqIEBwYXJhbSBleGVQYXRoIHRoZSBwYXRoIHRvIHRoZSBtaXRtZHVtcC5leGUuIGRlZmF1bHQgYXMgXCJtaXRtZHVtcFwiIHNvIG11c3QgYmUgaW4gc3lzdGVtIHBhdGguXHJcbiAgICogQHBhcmFtIHBvcnQgc2V0IHRoZSBwb3J0IHRvIHJ1biBvbi4gRGVmYXVsdCA4MDgwLlxyXG4gICAqL1xyXG4gIHB1YmxpYyBzdGF0aWMgYXN5bmMgQ3JlYXRlKFxyXG4gICAgY2I6IEludGVyY2VwdG9yID0gbm9wSW50ZXJjZXB0b3IsIFxyXG4gICAgaW50ZXJjZXB0UGF0aHM6IHN0cmluZ1tdID0gW10sIFxyXG4gICAgcXVpZXQ6IGJvb2xlYW4gPSB0cnVlLCBcclxuICAgIG9ubHlJbnRlcmNlcHRUZXh0RmlsZXMgPSBmYWxzZSwgXHJcbiAgICBpZ25vcmVIb3N0czogc3RyaW5nW10gfCBudWxsID0gbnVsbCxcclxuICAgIGFsbG93SG9zdHM6IHN0cmluZ1tdIHwgbnVsbCA9IG51bGwsXHJcbiAgICBleGVQYXRoID0gXCJtaXRtZHVtcFwiLFxyXG4gICAgcG9ydDogbnVtYmVyID0gODA4MFxyXG4gICk6IFByb21pc2U8TUlUTVByb3h5PiB7XHJcbiAgICAvLyBDb25zdHJ1Y3QgV2ViU29ja2V0IHNlcnZlciwgYW5kIHdhaXQgZm9yIGl0IHRvIGJlZ2luIGxpc3RlbmluZy5cclxuICAgIGNvbnN0IHdzcyA9IG5ldyBXZWJTb2NrZXRTZXJ2ZXIoeyBwb3J0OiA4NzY1IH0pO1xyXG4gICAgY29uc3QgcHJveHlDb25uZWN0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgIHdzcy5vbmNlKCdjb25uZWN0aW9uJywgKCkgPT4ge1xyXG4gICAgICAgIHJlc29sdmUoKTtcclxuICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIGNvbnN0IG1wID0gbmV3IE1JVE1Qcm94eShjYiwgb25seUludGVyY2VwdFRleHRGaWxlcyk7XHJcbiAgICAvLyBTZXQgdXAgV1NTIGNhbGxiYWNrcyBiZWZvcmUgTUlUTVByb3h5IGNvbm5lY3RzLlxyXG4gICAgbXAuX2luaXRpYWxpemVXU1Mod3NzKTtcclxuICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgd3NzLm9uY2UoJ2xpc3RlbmluZycsICgpID0+IHtcclxuICAgICAgICB3c3MucmVtb3ZlTGlzdGVuZXIoJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgICAgICByZXNvbHZlKCk7XHJcbiAgICAgIH0pO1xyXG4gICAgICB3c3Mub25jZSgnZXJyb3InLCByZWplY3QpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yUG9ydChwb3J0LCAxKTtcclxuICAgICAgICBpZiAoIXF1aWV0KSB7XHJcbiAgICAgICAgICBjb25zb2xlLmxvZyhgTUlUTVByb3h5IGFscmVhZHkgcnVubmluZy5gKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICBpZiAoIXF1aWV0KSB7XHJcbiAgICAgICAgICBjb25zb2xlLmxvZyhgTUlUTVByb3h5IG5vdCBydW5uaW5nOyBzdGFydGluZyB1cCBtaXRtcHJveHkuYCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIFN0YXJ0IHVwIE1JVE0gcHJvY2Vzcy5cclxuICAgICAgICAvLyAtLWFudGljYWNoZSBtZWFucyB0byBkaXNhYmxlIGNhY2hpbmcsIHdoaWNoIGdldHMgaW4gdGhlIHdheSBvZiB0cmFuc3BhcmVudGx5IHJld3JpdGluZyBjb250ZW50LlxyXG4gICAgICAgIGNvbnN0IHNjcmlwdEFyZ3MgPSBpbnRlcmNlcHRQYXRocy5sZW5ndGggPiAwID8gW1wiLS1zZXRcIiwgYGludGVyY2VwdD0ke2ludGVyY2VwdFBhdGhzLmpvaW4oXCIsXCIpfWBdIDogW107XHJcbiAgICAgICAgc2NyaXB0QXJncy5wdXNoKFwiLS1zZXRcIiwgYG9ubHlJbnRlcmNlcHRUZXh0RmlsZXM9JHtvbmx5SW50ZXJjZXB0VGV4dEZpbGVzfWApO1xyXG4gICAgICAgIHNjcmlwdEFyZ3MucHVzaChcIi0tbGlzdGVuLXBvcnRcIiwgYCR7cG9ydH1gKTtcclxuICAgICAgICBpZiAoaWdub3JlSG9zdHMpIHtcclxuICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaWdub3JlSG9zdHMubGVuZ3RoOyBpKyspIHtcclxuICAgICAgICAgICAgY29uc3QgaG9zdCA9IGlnbm9yZUhvc3RzW2ldO1xyXG4gICAgICAgICAgICBzY3JpcHRBcmdzLnB1c2goYC0taWdub3JlLWhvc3RzYCwgaG9zdCk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmKGFsbG93SG9zdHMpe1xyXG4gICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhbGxvd0hvc3RzLmxlbmd0aDsgaSsrKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGhvc3QgPSBhbGxvd0hvc3RzW2ldO1xyXG4gICAgICAgICAgICBzY3JpcHRBcmdzLnB1c2goYC0tYWxsb3ctaG9zdHNgLCBob3N0KTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIHBhdGggPSAocHJvY2Vzcy5wa2cpID8gcHJvY2Vzcy5jd2QoKSA6IF9fZGlybmFtZTtcclxuICAgICAgICBjb25zdCBvcHRpb25zID0gW1wiLS1hbnRpY2FjaGVcIiwgXCItc1wiLCByZXNvbHZlKHBhdGgsIGAuLi9zY3JpcHRzL3Byb3h5LnB5YCldLmNvbmNhdChzY3JpcHRBcmdzKTtcclxuICAgICAgICBpZiAocXVpZXQpIHtcclxuICAgICAgICAgIG9wdGlvbnMucHVzaCgnLXEnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgXHJcbiAgICAgICAgLy8gYWxsb3cgc2VsZi1zaWduZWQgU1NMIGNlcnRpZmljYXRlc1xyXG4gICAgICAgIG9wdGlvbnMucHVzaChcIi0tc3NsLWluc2VjdXJlXCIpO1xyXG4gICAgICAgIFxyXG4gICAgICAgIGNvbnN0IG1pdG1Qcm9jZXNzID0gc3Bhd24oZXhlUGF0aCwgb3B0aW9ucywge1xyXG4gICAgICAgICAgc3RkaW86ICdpbmhlcml0J1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGNvbnN0IG1pdG1Qcm94eUV4aXRlZCA9IG5ldyBQcm9taXNlPHZvaWQ+KChfLCByZWplY3QpID0+IHtcclxuICAgICAgICAgIG1pdG1Qcm9jZXNzLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgICAgICAgIG1pdG1Qcm9jZXNzLm9uY2UoJ2V4aXQnLCByZWplY3QpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmIChNSVRNUHJveHkuX2FjdGl2ZVByb2Nlc3Nlcy5wdXNoKG1pdG1Qcm9jZXNzKSA9PT0gMSkge1xyXG4gICAgICAgICAgcHJvY2Vzcy5vbignU0lHSU5UJywgTUlUTVByb3h5Ll9jbGVhbnVwKTtcclxuICAgICAgICAgIHByb2Nlc3Mub24oJ2V4aXQnLCBNSVRNUHJveHkuX2NsZWFudXApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBtcC5faW5pdGlhbGl6ZU1JVE1Qcm94eShtaXRtUHJvY2Vzcyk7XHJcbiAgICAgICAgLy8gV2FpdCBmb3IgcG9ydCA4MDgwIHRvIGNvbWUgb25saW5lLlxyXG4gICAgICAgIGNvbnN0IHdhaXRpbmdGb3JQb3J0ID0gd2FpdEZvclBvcnQocG9ydCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIC8vIEZhaWxzIGlmIG1pdG1wcm94eSBleGl0cyBiZWZvcmUgcG9ydCBiZWNvbWVzIGF2YWlsYWJsZS5cclxuICAgICAgICAgIGF3YWl0IFByb21pc2UucmFjZShbbWl0bVByb3h5RXhpdGVkLCB3YWl0aW5nRm9yUG9ydF0pO1xyXG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICAgIGlmIChlICYmIHR5cGVvZihlKSA9PT0gJ29iamVjdCcgJiYgZS5jb2RlID09PSBcIkVOT0VOVFwiKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgbWl0bWR1bXAsIHdoaWNoIGlzIGFuIGV4ZWN1dGFibGUgdGhhdCBzaGlwcyB3aXRoIG1pdG1wcm94eSwgaXMgbm90IG9uIHlvdXIgUEFUSC4gUGxlYXNlIGVuc3VyZSB0aGF0IHlvdSBjYW4gcnVuIG1pdG1kdW1wIC0tdmVyc2lvbiBzdWNjZXNzZnVsbHkgZnJvbSB5b3VyIGNvbW1hbmQgbGluZS5gKVxyXG4gICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gc3RhcnQgbWl0bXByb3h5OiAke2V9YCk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICAgIGF3YWl0IHByb3h5Q29ubmVjdGVkO1xyXG4gICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZTxhbnk+KChyZXNvbHZlKSA9PiB3c3MuY2xvc2UocmVzb2x2ZSkpO1xyXG4gICAgICB0aHJvdyBlO1xyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiBtcDtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgc3RhdGljIF9jbGVhbnVwQ2FsbGVkID0gZmFsc2U7XHJcbiAgcHJpdmF0ZSBzdGF0aWMgX2NsZWFudXAoKTogdm9pZCB7XHJcbiAgICBpZiAoTUlUTVByb3h5Ll9jbGVhbnVwQ2FsbGVkKSB7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIE1JVE1Qcm94eS5fY2xlYW51cENhbGxlZCA9IHRydWU7XHJcbiAgICBNSVRNUHJveHkuX2FjdGl2ZVByb2Nlc3Nlcy5mb3JFYWNoKChwKSA9PiB7XHJcbiAgICAgIHAua2lsbCgnU0lHS0lMTCcpO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIF9zdGFzaEVuYWJsZWQ6IGJvb2xlYW4gPSBmYWxzZTtcclxuICAvLyBUb2dnbGUgd2hldGhlciBvciBub3QgbWl0bXByb3h5LW5vZGUgc3Rhc2hlcyBtb2RpZmllZCBzZXJ2ZXIgcmVzcG9uc2VzLlxyXG4gIC8vICoqTm90IHVzZWQgZm9yIHBlcmZvcm1hbmNlKiosIGJ1dCBlbmFibGVzIE5vZGUuanMgY29kZSB0byBmZXRjaCBwcmV2aW91cyBzZXJ2ZXIgcmVzcG9uc2VzIGZyb20gdGhlIHByb3h5LlxyXG4gIHB1YmxpYyBnZXQgc3Rhc2hFbmFibGVkKCk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIHRoaXMuX3N0YXNoRW5hYmxlZDtcclxuICB9XHJcbiAgcHVibGljIHNldCBzdGFzaEVuYWJsZWQodjogYm9vbGVhbikge1xyXG4gICAgaWYgKCF2KSB7XHJcbiAgICAgIHRoaXMuX3N0YXNoLmNsZWFyKCk7XHJcbiAgICB9XHJcbiAgICB0aGlzLl9zdGFzaEVuYWJsZWQgPSB2O1xyXG4gIH1cclxuICBwcml2YXRlIF9taXRtUHJvY2VzczogQ2hpbGRQcm9jZXNzID0gbnVsbDtcclxuICAgLy8gQHRzLWV4cGVjdC1lcnJvclxyXG4gIHByaXZhdGUgX21pdG1FcnJvcjogRXJyb3IgPSBudWxsO1xyXG4gIHByaXZhdGUgX3dzczogV2ViU29ja2V0U2VydmVyID0gbnVsbDtcclxuICBwdWJsaWMgY2I6IEludGVyY2VwdG9yO1xyXG4gIHB1YmxpYyByZWFkb25seSBvbmx5SW50ZXJjZXB0VGV4dEZpbGVzOiBib29sZWFuO1xyXG4gIHByaXZhdGUgX3N0YXNoID0gbmV3IE1hcDxzdHJpbmcsIFN0YXNoZWRJdGVtPigpO1xyXG4gIHByaXZhdGUgX3N0YXNoRmlsdGVyOiAodXJsOiBzdHJpbmcsIGl0ZW06IFN0YXNoZWRJdGVtKSA9PiBib29sZWFuID0gZGVmYXVsdFN0YXNoRmlsdGVyO1xyXG4gIHB1YmxpYyBnZXQgc3Rhc2hGaWx0ZXIoKTogKHVybDogc3RyaW5nLCBpdGVtOiBTdGFzaGVkSXRlbSkgPT4gYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gdGhpcy5fc3Rhc2hGaWx0ZXI7XHJcbiAgfVxyXG4gIHB1YmxpYyBzZXQgc3Rhc2hGaWx0ZXIodmFsdWU6ICh1cmw6IHN0cmluZywgaXRlbTogU3Rhc2hlZEl0ZW0pID0+IGJvb2xlYW4pIHtcclxuICAgIGlmICh0eXBlb2YodmFsdWUpID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICAgIHRoaXMuX3N0YXNoRmlsdGVyID0gdmFsdWU7XHJcbiAgICB9IGVsc2UgaWYgKHZhbHVlID09PSBudWxsKSB7XHJcbiAgICAgIHRoaXMuX3N0YXNoRmlsdGVyID0gZGVmYXVsdFN0YXNoRmlsdGVyO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIHN0YXNoIGZpbHRlcjogRXhwZWN0ZWQgYSBmdW5jdGlvbi5gKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIHByaXZhdGUgY29uc3RydWN0b3IoY2I6IEludGVyY2VwdG9yLCBvbmx5SW50ZXJjZXB0VGV4dEZpbGVzOiBib29sZWFuKSB7XHJcbiAgICB0aGlzLmNiID0gY2I7XHJcbiAgICB0aGlzLm9ubHlJbnRlcmNlcHRUZXh0RmlsZXMgPSBvbmx5SW50ZXJjZXB0VGV4dEZpbGVzO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBfaW5pdGlhbGl6ZVdTUyh3c3M6IFdlYlNvY2tldFNlcnZlcik6IHZvaWQge1xyXG4gICAgdGhpcy5fd3NzID0gd3NzO1xyXG4gICAgdGhpcy5fd3NzLm9uKCdjb25uZWN0aW9uJywgKHdzKSA9PiB7XHJcbiAgICAgIHdzLm9uKCdlcnJvcicsIChlKSA9PiB7XHJcbiAgICAgICAgaWYgKChlIGFzIGFueSkuY29kZSAhPT0gXCJFQ09OTlJFU0VUXCIpIHtcclxuICAgICAgICAgIGNvbnNvbGUubG9nKGBXZWJTb2NrZXQgZXJyb3I6ICR7ZX1gKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgICB3cy5vbignbWVzc2FnZScsIGFzeW5jIChtZXNzYWdlOiBCdWZmZXIpID0+IHtcclxuICAgICAgICBjb25zdCBvcmlnaW5hbCA9IEludGVyY2VwdGVkSFRUUE1lc3NhZ2UuRnJvbUJ1ZmZlcihtZXNzYWdlKTtcclxuICAgICAgICBjb25zdCBydiA9IHRoaXMuY2Iob3JpZ2luYWwpO1xyXG4gICAgICAgIGlmIChydiAmJiB0eXBlb2YocnYpID09PSAnb2JqZWN0JyAmJiBydi50aGVuKSB7XHJcbiAgICAgICAgICBhd2FpdCBydjtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gUmVtb3ZlIHRyYW5zZmVyLWVuY29kaW5nLiBXZSBkb24ndCBzdXBwb3J0IGNodW5rZWQuXHJcbiAgICAgICAgaWYgKHRoaXMuX3N0YXNoRW5hYmxlZCkge1xyXG4gICAgICAgICAgY29uc3QgaXRlbSA9IG5ldyBTdGFzaGVkSXRlbShvcmlnaW5hbC5yZXF1ZXN0LnJhd1VybCwgb3JpZ2luYWwucmVzcG9uc2UuZ2V0SGVhZGVyKCdjb250ZW50LXR5cGUnKSwgb3JpZ2luYWwucmVzcG9uc2VCb2R5KTtcclxuICAgICAgICAgIGlmICh0aGlzLl9zdGFzaEZpbHRlcihvcmlnaW5hbC5yZXF1ZXN0LnJhd1VybCwgaXRlbSkpIHtcclxuICAgICAgICAgICAgdGhpcy5fc3Rhc2guc2V0KG9yaWdpbmFsLnJlcXVlc3QucmF3VXJsLCBpdGVtKTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgd3Muc2VuZChvcmlnaW5hbC50b0J1ZmZlcigpKTtcclxuICAgICAgfSk7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgX2luaXRpYWxpemVNSVRNUHJveHkobWl0bVByb3h5OiBDaGlsZFByb2Nlc3MpOiB2b2lkIHtcclxuICAgIHRoaXMuX21pdG1Qcm9jZXNzID0gbWl0bVByb3h5O1xyXG4gICAgdGhpcy5fbWl0bVByb2Nlc3Mub24oJ2V4aXQnLCAoY29kZSwgc2lnbmFsKSA9PiB7XHJcbiAgICAgIGNvbnN0IGluZGV4ID0gTUlUTVByb3h5Ll9hY3RpdmVQcm9jZXNzZXMuaW5kZXhPZih0aGlzLl9taXRtUHJvY2Vzcyk7XHJcbiAgICAgIGlmIChpbmRleCAhPT0gLTEpIHtcclxuICAgICAgICBNSVRNUHJveHkuX2FjdGl2ZVByb2Nlc3Nlcy5zcGxpY2UoaW5kZXgsIDEpO1xyXG4gICAgICB9XHJcbiAgICAgIGlmIChjb2RlICE9PSBudWxsKSB7XHJcbiAgICAgICAgaWYgKGNvZGUgIT09IDApIHtcclxuICAgICAgICAgIHRoaXMuX21pdG1FcnJvciA9IG5ldyBFcnJvcihgUHJvY2VzcyBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX0uYCk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIHRoaXMuX21pdG1FcnJvciA9IG5ldyBFcnJvcihgUHJvY2VzcyBleGl0ZWQgZHVlIHRvIHNpZ25hbCAke3NpZ25hbH0uYCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgdGhpcy5fbWl0bVByb2Nlc3Mub24oJ2Vycm9yJywgKGVycikgPT4ge1xyXG4gICAgICB0aGlzLl9taXRtRXJyb3IgPSBlcnI7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFJldHJpZXZlcyB0aGUgZ2l2ZW4gVVJMIGZyb20gdGhlIHN0YXNoLlxyXG4gICAqIEBwYXJhbSB1cmxcclxuICAgKi9cclxuICBwdWJsaWMgZ2V0RnJvbVN0YXNoKHVybDogc3RyaW5nKTogU3Rhc2hlZEl0ZW0ge1xyXG4gICAgcmV0dXJuIHRoaXMuX3N0YXNoLmdldCh1cmwpO1xyXG4gIH1cclxuXHJcbiAgcHVibGljIGZvckVhY2hTdGFzaEl0ZW0oY2I6ICh2YWx1ZTogU3Rhc2hlZEl0ZW0sIHVybDogc3RyaW5nKSA9PiB2b2lkKTogdm9pZCB7XHJcbiAgICB0aGlzLl9zdGFzaC5mb3JFYWNoKGNiKTtcclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFJlcXVlc3RzIHRoZSBnaXZlbiBVUkwgZnJvbSB0aGUgcHJveHkuXHJcbiAgICovXHJcbiAgcHVibGljIGFzeW5jIHByb3h5R2V0KHVybFN0cmluZzogc3RyaW5nLCBwb3J0OiBudW1iZXIgPSA4MDgwKTogUHJvbWlzZTxIVFRQUmVzcG9uc2U+IHtcclxuICAgIGNvbnN0IHVybCA9IHBhcnNlVVJMKHVybFN0cmluZyk7XHJcbiAgICBjb25zdCBnZXQgPSB1cmwucHJvdG9jb2wgPT09IFwiaHR0cDpcIiA/IGh0dHBHZXQgOiBodHRwc0dldDtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIVFRQUmVzcG9uc2U+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgY29uc3QgcmVxID0gZ2V0KHtcclxuICAgICAgICB1cmw6IHVybFN0cmluZyxcclxuICAgICAgICBoZWFkZXJzOiB7XHJcbiAgICAgICAgICBob3N0OiB1cmwuaG9zdFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgaG9zdDogJ2xvY2FsaG9zdCcsXHJcbiAgICAgICAgcG9ydDogcG9ydCxcclxuICAgICAgICBwYXRoOiB1cmxTdHJpbmdcclxuICAgICAgfSwgKHJlcykgPT4ge1xyXG4gICAgICAgIGNvbnN0IGRhdGEgPSBuZXcgQXJyYXk8QnVmZmVyPigpO1xyXG4gICAgICAgIHJlcy5vbignZGF0YScsIChjaHVuazogQnVmZmVyKSA9PiB7XHJcbiAgICAgICAgICBkYXRhLnB1c2goY2h1bmspO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJlcy5vbignZW5kJywgKCkgPT4ge1xyXG4gICAgICAgICAgY29uc3QgZCA9IEJ1ZmZlci5jb25jYXQoZGF0YSk7XHJcbiAgICAgICAgICByZXNvbHZlKHtcclxuICAgICAgICAgICAgc3RhdHVzQ29kZTogcmVzLnN0YXR1c0NvZGUsXHJcbiAgICAgICAgICAgIGhlYWRlcnM6IHJlcy5oZWFkZXJzLFxyXG4gICAgICAgICAgICBib2R5OiBkXHJcbiAgICAgICAgICB9IGFzIEhUVFBSZXNwb25zZSk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmVzLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgICAgfSk7XHJcbiAgICAgIHJlcS5vbmNlKCdlcnJvcicsIHJlamVjdCk7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIHB1YmxpYyBhc3luYyBzaHV0ZG93bigpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgIGNvbnN0IGNsb3NlV1NTID0gKCkgPT4ge1xyXG4gICAgICAgIHRoaXMuX3dzcy5jbG9zZSgoZXJyKSA9PiB7XHJcbiAgICAgICAgICBpZiAoZXJyKSB7XHJcbiAgICAgICAgICAgIHJlamVjdChlcnIpO1xyXG4gICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgcmVzb2x2ZSgpO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG4gICAgICB9O1xyXG5cclxuICAgICAgaWYgKHRoaXMuX21pdG1Qcm9jZXNzICYmICF0aGlzLl9taXRtUHJvY2Vzcy5raWxsZWQpIHtcclxuICAgICAgICB0aGlzLl9taXRtUHJvY2Vzcy5vbmNlKCdleGl0JywgKGNvZGUsIHNpZ25hbCkgPT4ge1xyXG4gICAgICAgICAgY2xvc2VXU1MoKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICB0aGlzLl9taXRtUHJvY2Vzcy5raWxsKCdTSUdURVJNJyk7XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgY2xvc2VXU1MoKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfVxyXG59XHJcbiJdfQ==