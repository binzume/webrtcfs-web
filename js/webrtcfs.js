'use strict';

// Please replace with your id and signalingKey!
const signalingUrl = 'wss://ayame-labo.shiguredo.app/signaling';
const roomIdPrefix = 'binzume@rdp-room-';

class BaseConnection {
	/**
	 * @param {string} signalingUrl 
	 * @param {string|undefined} signalingKey 
	 * @param {string} roomId 
	 */
	constructor(signalingUrl, signalingKey, roomId) {
		this.signalingUrl = signalingUrl;
		this.roomId = roomId;
		this.conn = null;
		/** @type {MediaStream|null} */
		this.mediaStream = null;
		this.stopTracksOnDisposed = true;
		/** @type {Record<string, DataChannelInfo>} */
		this.dataChannels = {};
		this.onstatechange = null;
		/** @type {'disconnected' | 'connecting' | 'waiting' | 'disposed' | 'connected'} */
		this.state = 'disconnected';
		this.options = Object.assign({}, Ayame.defaultOptions);
		this.options.video = Object.assign({}, this.options.video);
		this.options.audio = Object.assign({}, this.options.audio);
		this.options.signalingKey = signalingKey;
		this.reconnectWaitMs = -1;
		this.connectTimeoutMs = -1;
	}
	async connect() {
		if (this.conn || this.state == 'disposed') {
			throw 'invalid operation';
		}
		await this.setupConnection().connect(this.mediaStream, null);
	}
	setupConnection() {
		console.log("connecting..." + this.signalingUrl + " " + this.roomId);
		this.updateState('connecting');
		clearTimeout(this._connectTimer);
		if (this.connectTimeoutMs > 0) {
			this._connectTimer = setTimeout(() => this.disconnect(), this.connectTimeoutMs);
		}

		let conn = this.conn = Ayame.connection(this.signalingUrl, this.roomId, this.options, false);
		conn.on('open', async (e) => {
			for (let c of Object.keys(this.dataChannels)) {
				this._handleDataChannel(await conn.createDataChannel(c));
			}
			this.updateState('waiting');
		});
		conn.on('connect', (e) => {
			clearTimeout(this._connectTimer);
			this.updateState('connected');
		});
		conn.on('datachannel', (channel) => {
			this._handleDataChannel(channel);
		});
		conn.on('disconnect', (e) => {
			this.conn = null;
			this.disconnect(e.reason);
		});
		return conn;
	}
	/**
	 * @param {string|null} reason 
	 */
	disconnect(reason = null) {
		console.log('disconnect', reason);
		clearTimeout(this._connectTimer);
		if (this.conn) {
			this.conn.on('disconnect', () => { });
			this.conn.disconnect();
			this.conn.stream = null;
			this.conn = null;
		}
		if (reason != 'dispose' && this.state != 'disconnected' && this.reconnectWaitMs >= 0) {
			this._connectTimer = setTimeout(() => this.connect(), this.reconnectWaitMs);
		}
		for (let c of Object.values(this.dataChannels)) {
			c.ch = null;
		}
		this.updateState('disconnected', reason);
	}
	dispose() {
		this.disconnect('dispose');
		this.updateState('disposed');
		this.stopTracksOnDisposed && this.mediaStream?.getTracks().forEach(t => t.stop());
		this.mediaStream = null;
	}
	/**
	 * @param {'disconnected' | 'connecting' | 'waiting' | 'disposed' | 'connected'} s
	 * @param {string|null} reason 
	 */
	updateState(s, reason = null) {
		if (s != this.state && this.state != 'disposed') {
			console.log(this.roomId, s);
			let oldState = this.state;
			this.state = s;
			this.onstatechange && this.onstatechange(s, oldState, reason);
		}
	}
	/**
	 * @param {RTCDataChannel|null} ch
	 */
	_handleDataChannel(ch) {
		if (!ch) return;
		let c = this.dataChannels[ch.label];
		if (c && !c.ch) {
			console.log('datachannel', ch.label);
			c.ch = ch;
            ch.onmessage = (ev) => c.onmessage?.(ch, ev);
            // NOTE: dataChannel.onclose = null in Ayame web sdk.
            ch.addEventListener('open', (ev) => c.onopen?.(ch, ev));
            ch.addEventListener('close', (ev) => c.onclose?.(ch, ev));		}
	}
    getFingerprint(remote = false) {
        let pc = this.conn._pc;
        let m = pc && (remote ? pc.currentRemoteDescription : pc.currentLocalDescription).sdp.match(/a=fingerprint:\s*([\w-]+ [a-f0-9:]+)/i);
        return m && m[1];
    }
	async hmacSha256(password, fingerprint) {
		let enc = new TextEncoder();
		let key = await crypto.subtle.importKey('raw', enc.encode(password),
			{ name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']);
		let sign = await crypto.subtle.sign('HMAC', key, enc.encode(fingerprint));
		return btoa(String.fromCharCode(...new Uint8Array(sign)));
	}
}

class FsClientConnection extends BaseConnection {
	/**
	 * @param {string} signalingUrl 
	 * @param {string} roomId 
	 */
	constructor(signalingUrl, signalingKey, roomId) {
		super(signalingUrl, signalingKey, roomId);
		this._rpcResultHandler = {};
		this.authToken = null;
		this.services = null;
		this.onauth = null;
		this.dataChannels['controlEvent'] = {
			onopen: async (ch, ev) => {
				if (window.crypto?.subtle) {
					// use HMAC
					let localFingerprint = this.getFingerprint();
					if (!localFingerprint) {
						console.log("Failed to get DTLS cert fingerprint");
						return;
					}
					console.log("local fingerprint:", localFingerprint);
					let hmac = this.authToken && await this.hmacSha256(this.authToken, localFingerprint);
					ch.send(JSON.stringify({
						type: "auth",
						requestServices: ['file'],
						fingerprint: localFingerprint,
						hmac: hmac,
					}));
				} else {
					ch.send(JSON.stringify({ type: "auth", token: this.authToken, requestServices: ['file'] }));
				}
			},
			onmessage: (ch, ev) => {
				let msg = JSON.parse(ev.data);
				if (msg.type == 'redirect' && msg.roomId) {
					this.disconnect('redirect');
					this.roomId = msg.roomId;
					this.connect();
				} else if (msg.type == 'authResult') {
					this.services = msg.services;
					this.onauth?.(msg.result);
				} else if (msg.type == 'rpcResult') {
					this._rpcResultHandler[msg.reqId]?.(msg);
				}
			}
		};
	}
	sendRpcAsync(name, params, timeoutMs = 10000) {
		let reqId = Date.now(); // TODO: monotonic
		this.dataChannels['controlEvent'].ch?.send(JSON.stringify({ type: 'rpc', name: name, reqId: reqId, params: params }));
		return new Promise((resolve, reject) => {
			let timer = setTimeout(() => {
				delete this._rpcResultHandler[reqId];
				reject('timeout');
			}, timeoutMs);
			this._rpcResultHandler[reqId] = (res) => {
				clearTimeout(timer);
				delete this._rpcResultHandler[reqId];
				resolve(res.value);
			};
		});
	}
}


class BaseFileList {
	/**
	 * @param {string} itemPath
	 */
	constructor(itemPath) {
		this.itemPath = itemPath;
		this.size = -1;
		this.name = "";
		/** @type {string} */
		this.thumbnailUrl = null;
		this.onupdate = null;
	}
	async getItems(path, offset, limit, options = null, signal = null) {
	}

	notifyUpdate() {
		if (this.onupdate) {
			this.onupdate();
		}
	}
}

class StorageList extends BaseFileList {
	constructor(accessors) {
		super('');
		this.accessors = accessors || {};
		this.itemPath = '/';
		this.name = "Storage";
		this._update();
	}
	_update() {
		/**
		 * @type {object[]}
		 */
		let items = [];
		for (let [k, sa] of Object.entries(this.accessors)) {
			if (sa == this) {
				continue;
			}
			if (sa.shortcuts && Object.keys(sa.shortcuts).length) {
				Object.keys(sa.shortcuts).forEach(n => {
					items.push({ name: n, type: 'folder', storage: k, path: sa.shortcuts[n], updatedTime: '' });
				});
			} else {
				items.push({ name: sa.name, type: 'folder', storage: k, path: k, updatedTime: '', remove: () => this.removeStorage(k) });
			}
		}
		this.items = items;
		this.size = items.length;
	}
	addStorage(id, data) {
		this.accessors[id] = data;
		this._update();
		this.notifyUpdate();
	}
	removeStorage(id) {
		if (!this.accessors[id]) { return false; }
		this.accessors[id].detach && this.accessors[id].detach();
		delete this.accessors[id];
		this._update();
		this.notifyUpdate();
		return true;
	}
	getFolder(path, prefix = '') {
		if (!path) {
			return this;
		}
		let storage = path.split('/', 1)[0];
		path = path.substring(storage.length + 1);
		let accessor = this.accessors[storage];
		if (!accessor) {
			return null;
		}
		return accessor.getFolder(path, prefix + storage + '/');
	}
	async getFiles(offset, limit, options = null, signal = null) {
		if (options && options.sortField) {
			this._setSort(options.sortField, options.sortOrder);
		}
		limit ||= this.items.length;
		return {
			items: this.items.slice(offset, offset + limit),
			next: offset + limit < this.items.length ? offset + limit : null,
		};
	}
	_setSort(field, order) {
		let r = order === "a" ? 1 : -1;
		if (field === "name") {
			this.items.sort((a, b) => (a.name || "").localeCompare(b.name) * r);
		} else if (field === "updatedTime") {
			this.items.sort((a, b) => (a.updatedTime || "").localeCompare(b.updatedTime) * r);
		} else if (field === "size") {
			this.items.sort((a, b) => ((a.size && b.size) ? a.size - b.size : 0) * r);
		}
	}
}

(function () {
	let storageList = new StorageList(globalThis.storageAccessors);
	globalThis.folderResolver = storageList;

	function add(roomId, signalingKey, password, name) {
		let client = new RTCFileSystemClient();
		let player = null;
		let id = roomId.startsWith(roomIdPrefix) ? roomId.substring(roomIdPrefix.length) : roomId;
		storageList.addStorage(id, {
			name: name,
			root: '',
			detach: () => player && player.dispose(),
			getFolder: (path, prefix) => {
				if (player == null) {
					player = new FsClientConnection(signalingUrl, signalingKey, roomId);
					player.authToken = password;
					player.dataChannels['fileServer'] = {
						onopen: (ch, _ev) => client.addSocket(ch, false),
						onclose: (ch, _ev) => client.removeSocket(ch),
						onmessage: (_ch, ev) => client.handleEvent(ev),
					};
					player.onauth = (ok) => {
						if (!ok) {
							player.disconnect();
							return;
						}
						client.setAvailable(true);
					};
					player.onstatechange = (state, oldState, reason) => {
						if (state == 'disconnected' && reason != 'redirect') {
							player = null;
						}
					};
					player.connect();
				}
				return new RTCFileSystemClientFolder(client, path, prefix);
			}
		});
	}

	// see https://github.com/binzume/webrtc-rdp
	let config = JSON.parse(localStorage.getItem('webrtc-rdp-settings') || 'null') || { devices: [] };
	let devices = config.devices != null ? config.devices : [config];
	for (let device of devices) {
		let name = (device.name || device.userAgent || device.roomId).substring(0, 64);
		add(device.roomId, device.signalingKey, device.token, name);
	}
})();
