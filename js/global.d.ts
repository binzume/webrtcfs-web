
declare var Ayame: typeof import('@open-ayame/ayame-web-sdk')

interface Document {
    // Safari Fullscreen
    webkitExitFullscreen(): void;
    webkitFullscreenElement: Element;
}

interface HTMLElement {
    // Safari Fullscreen
    webkitRequestFullscreen(): void;
}

declare interface FileInfo {
    type: string;
    name: string;
    size: number;
    remove?(): any;
}

declare interface FilesResult {
    name: string;
    items: FileInfo[];
    next: any;
    more: boolean;
}

declare interface Folder {
    getFiles(offset: any, limit: number, options: object, signal: AbortSignal): Promise<FilesResult>;
}

declare interface FolderResolver {
    getFolder(path: string): Folder;
}

declare interface DataChannelInfo {
    onmessage?: ((ch: RTCDataChannel, ev: MessageEvent) => void)
    onopen?: ((ch: RTCDataChannel, ev: Event) => void)
    onclose?: ((ch: RTCDataChannel, ev: Event) => void)
    ch?: RTCDataChannel | null
}

declare interface DeviceSettings {
    name?: string
    roomId: string
    publishRoomId?: string | null
    localToken?: string,
    signalingKey: string | null
    userAgent: string
    token: string
}

declare var MP4Player: any;
declare var BufferedReader: any;
declare var folderResolver: FolderResolver | null;
