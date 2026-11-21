export type RibbonTab =
  | 'home'
  | 'comment'
  | 'edit'
  | 'organize'
  | 'form'
  | 'ocr';

export type ActiveTool =
  | 'select'
  | 'hand'
  | 'highlight'
  | 'draw'
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'note'
  | 'stamp'
  | 'text'
  | 'redact'
  | 'image'
  | 'signature'
  | 'yousign-zone'
  | 'form-text'
  | 'form-checkbox';

export const TOOL_LABELS_FR: Record<ActiveTool, string> = {
  select: 'Sélection',
  hand: 'Main (déplacement)',
  highlight: 'Surlignage',
  draw: 'Stylo libre',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  arrow: 'Flèche',
  note: 'Note adhésive',
  stamp: 'Tampon',
  text: 'Bloc de texte',
  redact: 'Caviardage',
  image: 'Insertion image',
  signature: 'Signature locale',
  'yousign-zone': 'Zone Yousign',
  'form-text': 'Champ texte AcroForm',
  'form-checkbox': 'Case AcroForm',
};

export type SidebarPanel = 'thumbnails' | 'outline' | 'comments' | 'search';

export type StampPreset =
  | 'APPROUVÉ'
  | 'CONFIDENTIEL'
  | 'BROUILLON'
  | 'URGENT'
  | 'SIGNÉ'
  | 'RÉVISÉ';

export interface Point {
  x: number; // normalized 0..1 relative to visible page width
  y: number; // normalized 0..1 relative to visible page height
}

export interface OverlayItem {
  id: string;
  pageIndex: number; // 0-based
  kind:
    | 'highlight'
    | 'draw'
    | 'rect'
    | 'ellipse'
    | 'arrow'
    | 'note'
    | 'stamp'
    | 'text'
    | 'redact'
    | 'image'
    | 'signature'
    | 'yousign-zone'
    | 'ocr-layer'
    | 'form-text'
    | 'form-checkbox';
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  w: number; // normalized 0..1
  h: number; // normalized 0..1
  color: string;
  strokeWidth?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  bold?: boolean;
  points?: Point[]; // for draw / arrow
  imageDataUrl?: string; // strictly data:image/(png|jpeg);base64,...
  stampLabel?: StampPreset;
  checked?: boolean; // for form-checkbox
  author?: string;
  createdAt: string;
}

export interface WatermarkConfig {
  enabled: boolean;
  text: string;
  color: string;
  opacity: number;
  angle: number;
  fontSize: number;
}

export interface HeaderFooterConfig {
  enabled: boolean;
  headerLeft: string;
  headerRight: string;
  footerLeft: string;
  footerRight: string; // supports {page} and {total}
}

export interface OutlineEntry {
  title: string;
  pageIndex: number;
}

export interface SearchMatch {
  pageIndex: number;
  snippet: string;
  count: number;
}

export interface PdfTabDocument {
  id: string;
  name: string;
  bytes: Uint8Array;
  numPages: number;
  currentPage: number; // 1-based
  zoom: number;
  dirty: boolean;
  purgeMetadata: boolean;
  overlays: OverlayItem[];
  undoStack: OverlayItem[][];
  redoStack: OverlayItem[][];
  watermark: WatermarkConfig;
  headerFooter: HeaderFooterConfig;
  outline: OutlineEntry[];
}

export interface SavedSignature {
  id: string;
  label: string;
  dataUrl: string;
}

export interface YousignPlacedZone {
  page: number; // 1-based
  x: number; // 72-DPI top-left px
  y: number;
  width: number;
  height: number;
}

export interface FDesktopBridge {
  isElectron: boolean;
  platform: string;
  openPdfDialog: () => Promise<Array<{ name: string; bytes: Uint8Array }>>;
  savePdfDialog: (
    defaultName: string,
    bytes: Uint8Array
  ) => Promise<{ saved: boolean; filePath?: string }>;
  openExternal: (url: string) => Promise<boolean>;
  onFileOpened?: (
    cb: (payload: { name: string; bytes: Uint8Array }) => void
  ) => () => void;
  yousign: {
    getConfig: () => Promise<{
      env: 'demo' | 'sandbox' | 'production';
      hasApiKey: boolean;
      ephemeral?: boolean;
    }>;
    saveConfig: (cfg: {
      env: 'demo' | 'sandbox' | 'production';
      apiKey?: string;
      clearKey?: boolean;
    }) => Promise<{
      env: 'demo' | 'sandbox' | 'production';
      hasApiKey: boolean;
      ephemeral?: boolean;
    }>;
    send: (req: unknown) => Promise<unknown>;
    status: (record: unknown) => Promise<unknown>;
    download: (record: unknown) => Promise<Uint8Array>;
  };
}

declare global {
  interface Window {
    fDesktop?: FDesktopBridge;
  }
}
