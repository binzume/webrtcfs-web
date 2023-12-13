
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
    path: string;
    updatedTime: number;
    tags?: string[];
    thumbnail?: { type?: string, fetch?: () => Promise<Response>, [k: string]: any };
    remove?(): Promise<any>;
    rename?(name: string): Promise<any>;
    fetch?(): Promise<Response>;
    stream?(): Promise<ReadableStream>;
    createWritable?(): Promise<WritableStream>;
    [k: string]: any;
}

declare interface FilesResult {
    name?: string;
    items: FileInfo[];
    next: any;
    more?: boolean;
}

declare interface Folder {
    getFiles(offset: any, limit: number, options: object, signal: AbortSignal): Promise<FilesResult>;
    getInfo?(): Promise<{ name: string, [k: string], any }>;
    writeFile?(name: string, content: any): Promise<any>;
    getParentPath(): string | null;
    onupdate?: () => any;
    sequentialAccess?: boolean;
}

declare interface PathResolver {
    getFolder(path: string, prefix?: string): Folder;
    parsePath(path: string): string[][];
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
declare var pathResolver: PathResolver | undefined;
