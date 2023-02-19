// @ts-check
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
		if (this.connectTimeoutMs > 0) {
			this._connectTimer = setTimeout(() => this.disconnect(), this.connectTimeoutMs);
		}

		let conn = this.conn = Ayame.connection(this.signalingUrl, this.roomId, this.options, false);
		conn.on('open', async (e) => {
			for (let c of Object.keys(this.dataChannels)) {
				this.handleDataChannel(await conn.createDataChannel(c));
			}
			this.updateState('waiting');
		});
		conn.on('connect', (e) => {
			clearTimeout(this._connectTimer);
			this.updateState('connected');
		});
		conn.on('datachannel', (channel) => {
			this.handleDataChannel(channel);
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
			setTimeout(() => this.connect(), this.reconnectWaitMs);
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
	handleDataChannel(ch) {
		if (!ch) return;
		let c = this.dataChannels[ch.label];
		if (c && !c.ch) {
			console.log('datachannel', ch.label);
			c.ch = ch;
			ch.onmessage = c.onmessage?.bind(ch, ch);
			// NOTE: dataChannel.onclose = null in Ayame web sdk.
			c.onopen && ch.addEventListener('open', c.onopen.bind(ch, ch));
			c.onclose && ch.addEventListener('close', c.onclose.bind(ch, ch));
		}
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
				if (this.authToken && this.conn._pc && window.crypto?.subtle) {
					// use HMAC
					let m = this.conn._pc.currentLocalDescription.sdp.match(/a=fingerprint:\s*([\w-]+ [a-f0-9:]+)/i);
					if (!m) {
						console.log("Failed to get DTLS cert fingerprint");
						return;
					}
					let localFingerprint = m[1];
					console.log("local fingerprint:", localFingerprint);
					let enc = new TextEncoder();
					let key = await crypto.subtle.importKey('raw', enc.encode(this.authToken),
						{ name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']);
					let sign = await crypto.subtle.sign('HMAC', key, enc.encode(localFingerprint));
					ch.send(JSON.stringify({
						type: "auth",
						fingerprint: localFingerprint,
						hmac: btoa(String.fromCharCode(...new Uint8Array(sign)))
					}));
				} else if (this.authToken) {
					ch.send(JSON.stringify({ type: "auth", token: this.authToken }));
				}
			},
			onmessage: (ch, ev) => {
				let msg = JSON.parse(ev.data);
				if (msg.type == 'redirect' && msg.roomId) {
					this.disconnect();
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
	 * @param {{[key:string]:string}?} options
	 */
	constructor(itemPath, options) {
		this.itemPath = itemPath;
		this.options = options || {};
		this.size = -1;
		this.name = "";
		/** @type {string} */
		this.thumbnailUrl = null;
		this.onupdate = null;
	}

	/**
	 * @returns {Promise<void>}
	 */
	async init() {
		await this.get(0)
	}

	/**
	 * @returns {Promise<ContentInfo>}
	 */
	async get(position) {
		throw 'not implemented';
	}

	notifyUpdate() {
		if (this.onupdate) {
			this.onupdate();
		}
	}
}

class StorageList extends BaseFileList {
	constructor(accessors, options) {
		super('', options);
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
				items.push({ name: sa.name, type: 'folder', storage: k, path: k, updatedTime: '' });
			}
		}
		this.items = items;
		this.size = items.length;
		let options = this.options;
		if (options.orderBy) {
			this._setSort(options.orderBy, options.order);
		}
	}
	getList(path, options) {
		let storage = path.split('/', 1)[0];
		if (storage == '') {
			return this;
		}
		path = path.substring(storage.length + 1);
		let accessor = this.accessors[storage];
		if (!accessor) {
			return null;
		}
		return accessor.getList(path || accessor.root, options);
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
	get(position) {
		return Promise.resolve(this.items[position]);
	}
	_setSort(orderBy, order) {
		let r = order === "a" ? 1 : -1;
		if (orderBy === "name") {
			this.items.sort((a, b) => (a.name || "").localeCompare(b.name) * r);
		} else if (orderBy === "updated") {
			this.items.sort((a, b) => (a.updatedTime || "").localeCompare(b.updatedTime) * r);
		} else if (orderBy === "size") {
			this.items.sort((a, b) => ((a.size && b.size) ? a.size - b.size : 0) * r);
		}
	}
}

class RtcfsFileListLoader {
	constructor(path, storageList) {
		this.path = path || '';
		this.sortOrder = 'd';
		this.sortField = 'updated';
		this.storageList = storageList;
	}
	async load(offset) {
		let path = this.path;
		let storage = path.split('/', 1)[0];
		let list = this.storageList.getList(path);
		if (!list) {
			return null;
		}
		let items = [];
		let eol = false;
		for (let i = 0; i < 100; i++) {
			if (list.size >= 0 && offset + i >= list.size) {
				eol = true;
				break;
			}
			let item = await list.get(offset + i);
			if (!item) {
				eol = true;
				break;
			}
			item.path = [storage, item.path].filter(p => p).join('/');
			item.remove = () => this.storageList.removeStorage(item.name);
			items.push(item);
		}
		this.offset = items.length;
		return {
			items: items,
			writable: false,
			next: eol ? null : (offset || 0) + items.length,
		};
	}
}

(function () {
	let storageList = new StorageList(globalThis.storageAccessors);
	globalThis.fileListLoader = new RtcfsFileListLoader('', storageList);
	globalThis.sideMenuListLoader = new RtcfsFileListLoader('', storageList);

	function add(roomId, signalingKey, password, name) {
		let client = new RTCFileSystemClient();
		let player = null;
		storageList.addStorage(name, {
			name: name,
			root: '',
			shortcuts: {},
			detach: () => player && player.dispose(),
			getList: (folder, options) => {
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
						if (state == 'disconnected' && reason != 'dispose') {
							player = null;
						}
					};
					player.connect();
				}
				return new RTCFileSystemClientFolder(client, folder, folder || name, options);
			}
		});
	}

	let config = JSON.parse(localStorage.getItem('webrtc-rdp-settings') || 'null') || { devices: [] };
	let devices = config.devices != null ? config.devices : [config];
	for (let device of devices) {
		let name = (device.name || device.userAgent || device.roomId).replace(/[\/\\\?&!\"\']+/, '_').substring(0, 64);
		add(device.roomId, device.signalingKey, device.token, name);
	}
})();
