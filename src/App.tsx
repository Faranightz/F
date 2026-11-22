import React, { useCallback, useEffect, useRef, useState } from 'react';
import type * as pdfjsLib from 'pdfjs-dist';
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import {
  ArrowRight,
  Bold,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Crosshair,
  Download,
  Eraser,
  EyeOff,
  FileImage,
  FilePlus2,
  FileText,
  FileBadge,
  FileType2,
  FolderOpen,
  FolderPlus,
  GitCompare,
  Grid,
  Lock,
  PencilLine,
  ScanSearch,
  Hand,
  Highlighter,
  ImagePlus,
  Layers,
  Moon,
  MousePointer2,
  Pen,
  PenTool,
  Printer,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  ScanText,
  Scissors,
  Search,
  ShieldCheck,
  Square,
  Stamp,
  StickyNote,
  Sun,
  TextCursorInput,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  TOOL_LABELS_FR,
  type ActiveTool,
  type OcrLine,
  type OverlayItem,
  type PdfSecurity,
  type PdfTabDocument,
  type RibbonTab,
  type SavedSignature,
  type SearchMatch,
  type SidebarPanel,
  type StampPreset,
  type YousignPlacedZone,
} from './types/pdf';
import {
  bakeEditsToPdf,
  createBlankPdf,
  createSamplePdf,
  deletePdfPage,
  duplicatePdfPage,
  extractAllText,
  extractOutline,
  drawCertificateAppearance,
  extractPdfPages,
  insertBlankPdfPage,
  loadPdfWithTask,
  mergePdfDocuments,
  normalizeImageFileToDataUrl,
  renderBakedPageToBlob,
  reorderPdfPages,
  rotateOverlaysForPage,
  rotatePdfPage,
  searchPdfText,
  triggerDownload,
} from './utils/pdfEngine';
import { PageCanvas } from './components/PageCanvas';
import { Sidebar } from './components/Sidebar';
import { OrganizeView } from './components/OrganizeView';
import { SignatureModal } from './components/SignatureModal';
import { YousignModal } from './components/YousignModal';
import { PasswordPromptModal, SecurityModal } from './components/SecurityModals';
import { CompareModal } from './components/CompareModal';
import { CertSignModal, type CertSignRequest } from './components/CertSignModal';
import { decryptPdf, importFpdfAnnotations, isPasswordError } from './utils/pdfDraw';
import { comparePdfDocuments, type PageComparison } from './utils/pdfTools';
import { convertPdfToDocx } from './utils/pdfToWord';

/** Recognized text lines of a rendered page, normalized to 0..1 (for the OCR text layer). */
function ocrLinesFromResult(
  data: { blocks?: Array<{ paragraphs: Array<{ lines: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }> }> }> | null },
  width: number,
  height: number
): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        const text = line.text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        lines.push({
          text,
          x: line.bbox.x0 / width,
          y: line.bbox.y0 / height,
          w: (line.bbox.x1 - line.bbox.x0) / width,
          h: (line.bbox.y1 - line.bbox.y0) / height,
        });
      }
    }
  }
  return lines;
}

const DEFAULT_WATERMARK = {
  enabled: false,
  text: 'CONFIDENTIEL',
  color: '#b91c1c',
  opacity: 0.16,
  angle: 45,
  fontSize: 54,
};

const DEFAULT_HEADER_FOOTER = {
  enabled: false,
  headerLeft: 'F-pdf — Document PDF',
  headerRight: new Date().toLocaleDateString('fr-FR'),
  footerLeft: 'Édité avec F-pdf',
  footerRight: 'Page {page} / {total}',
};

const STAMP_PRESETS: StampPreset[] = [
  'APPROUVÉ',
  'CONFIDENTIEL',
  'BROUILLON',
  'URGENT',
  'SIGNÉ',
  'RÉVISÉ',
];

const COLOR_PALETTE = [
  '#1746d1',
  '#dc2626',
  '#15803d',
  '#e83e8c',
  '#111827',
  '#eab308',
];

const SAVED_SIG_STORAGE = 'f_saved_signatures_v1';
const RECENT_FILES_STORAGE = 'f_recent_files_v1';
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export default function App() {
  const [darkMode, setDarkMode] = useState(false);
  const [tabs, setTabs] = useState<PdfTabDocument[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('');
  const [pdfProxy, setPdfProxy] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [dragOverFile, setDragOverFile] = useState(false);

  const [ribbonTab, setRibbonTab] = useState<RibbonTab>('home');
  const [activeTool, setActiveTool] = useState<ActiveTool>('select');
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>('thumbnails');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [organizeMode, setOrganizeMode] = useState(false);

  const [toolColor, setToolColor] = useState('#1746d1');
  const [strokeWidth, setStrokeWidth] = useState(2.5);
  const [fontSize, setFontSize] = useState(14);
  const [stampPreset, setStampPreset] = useState<StampPreset>('APPROUVÉ');
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);

  const [pendingImageDataUrl, setPendingImageDataUrl] = useState<string | null>(null);
  const [pendingSignatureDataUrl, setPendingSignatureDataUrl] = useState<string | null>(null);
  // Saved signatures: encrypted by Windows (DPAPI) in the desktop app,
  // browser storage only in the web preview
  const [savedSignatures, setSavedSignatures] = useState<SavedSignature[]>(() => {
    if (window.fDesktop?.secureStore) return [];
    try {
      const raw = localStorage.getItem(SAVED_SIG_STORAGE);
      return raw ? (JSON.parse(raw) as SavedSignature[]) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    const store = window.fDesktop?.secureStore;
    if (!store) return;
    let cancelled = false;
    (async () => {
      let raw = await store.get('signatures');
      let legacy: string | null = null;
      try {
        legacy = localStorage.getItem(SAVED_SIG_STORAGE);
      } catch {
        legacy = null;
      }
      if (!raw && legacy) {
        // Migrate signatures saved in clear by older versions
        if (await store.set('signatures', legacy)) raw = legacy;
      }
      if (raw && legacy) {
        try {
          localStorage.removeItem(SAVED_SIG_STORAGE);
        } catch {
          // ignore
        }
      }
      if (!cancelled && raw) {
        try {
          setSavedSignatures(JSON.parse(raw) as SavedSignature[]);
        } catch {
          // corrupted: ignore
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const persistSignatures = useCallback((next: SavedSignature[]) => {
    const json = JSON.stringify(next);
    const store = window.fDesktop?.secureStore;
    if (store) {
      store.set('signatures', json).catch(() => {});
      return;
    }
    try {
      localStorage.setItem(SAVED_SIG_STORAGE, json);
    } catch {
      // Ignore storage quota exceeded
    }
  }, []);
  const [recentFiles, setRecentFiles] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_FILES_STORAGE);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  const [sigModalOpen, setSigModalOpen] = useState(false);
  const [yousignModalOpen, setYousignModalOpen] = useState(false);
  const [yousignModalKey, setYousignModalKey] = useState(0);
  const [placedYousignZone, setPlacedYousignZone] = useState<YousignPlacedZone | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);

  // OCR state
  const [ocrLang, setOcrLang] = useState<'fra' | 'eng'>('fra');
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrText, setOcrText] = useState('');
  const ocrWorkerRef = useRef<TesseractWorker | null>(null);
  const [ocrLines, setOcrLines] = useState<OcrLine[]>([]);
  const ocrCancelRef = useRef(false);

  // Password prompt (protected PDFs), protection settings, comparison
  const [pwPrompt, setPwPrompt] = useState<{
    fileName: string;
    error?: string;
    resolve: (pw: string | null) => void;
  } | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [certModal, setCertModal] = useState<{
    draft: Partial<CertSignRequest> | null;
    busy: boolean;
    error: string | null;
  } | null>(null);
  const certDraftRef = useRef<Partial<CertSignRequest> | null>(null);
  const [compare, setCompare] = useState<{
    otherName: string;
    result: PageComparison[] | null;
    error: string | null;
  } | null>(null);
  const askPassword = useCallback(
    (fileName: string, error?: string) =>
      new Promise<string | null>((resolve) => setPwPrompt({ fileName, error, resolve })),
    []
  );

  const [toast, setToast] = useState<string | null>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const panStateRef = useRef<{
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 3400);
  }, []);

  const handleCanvasReady = useCallback((canvas: HTMLCanvasElement | null) => {
    activeCanvasRef.current = canvas;
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) || null;
  const activeTabBytes = activeTab?.bytes ?? null;
  const hasDoc = Boolean(activeTab);

  const updateActiveTab = useCallback(
    (updater: (tab: PdfTabDocument) => PdfTabDocument) => {
      setTabs((prev) => prev.map((t) => (t.id === activeTabId ? updater(t) : t)));
    },
    [activeTabId]
  );

  const recordRecentFile = useCallback((name: string) => {
    setRecentFiles((prev) => {
      const next = [name, ...prev.filter((n) => n !== name)].slice(0, 6);
      try {
        localStorage.setItem(RECENT_FILES_STORAGE, JSON.stringify(next));
      } catch {
        // ignore quota
      }
      return next;
    });
  }, []);

  // Open a new tab from PDF bytes with full error handling
  const openBytesInTab = useCallback(
    async (name: string, rawBytes: Uint8Array) => {
      try {
        let bytes = rawBytes;
        let security: PdfSecurity | null = null;
        let loaded: Awaited<ReturnType<typeof loadPdfWithTask>> | null = null;
        try {
          loaded = await loadPdfWithTask(bytes);
        } catch (err) {
          if (!isPasswordError(err)) throw err;
          // Protected PDF: ask for the password (3 tries), then work on a decrypted copy.
          // The protection is kept and applied again when saving.
          let error: string | undefined;
          for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
            const pw = await askPassword(name, error);
            if (!pw) return;
            try {
              const check = await loadPdfWithTask(rawBytes, pw);
              await check.task.destroy();
              bytes = await decryptPdf(rawBytes, pw);
              loaded = await loadPdfWithTask(bytes);
              security = { userPassword: pw, ownerPassword: '', allowPrint: true, allowCopy: true, allowModify: true };
            } catch (pwErr) {
              if (!isPasswordError(pwErr)) throw pwErr;
              error = 'Mot de passe incorrect.';
            }
          }
          if (!loaded) {
            showToast(`Mot de passe incorrect : « ${name} » n’a pas été ouvert.`);
            return;
          }
        }
        // Annotations written by F-pdf become editable again
        const imported = await importFpdfAnnotations(bytes);
        if (imported.overlays.length) {
          await loaded.task.destroy();
          bytes = imported.bytes;
          loaded = await loadPdfWithTask(bytes);
        }
        const { task, doc } = loaded;
        const outline = await extractOutline(doc);
        const numPages = doc.numPages;
        await task.destroy();
        const id = crypto.randomUUID();
        const tabDoc: PdfTabDocument = {
          id,
          name,
          bytes,
          numPages,
          currentPage: 1,
          zoom: 1.15,
          dirty: false,
          purgeMetadata: false,
          overlays: imported.overlays,
          undoStack: [],
          redoStack: [],
          watermark: { ...DEFAULT_WATERMARK },
          headerFooter: { ...DEFAULT_HEADER_FOOTER },
          outline,
          flattenAnnotations: false,
          security,
        };
        // Already signed? Saving from F-pdf rewrites the file and would break the signature
        const head = new TextDecoder('latin1').decode(bytes.length > 4_000_000 ? bytes.subarray(bytes.length - 4_000_000) : bytes);
        tabDoc.signed = /\/ByteRange\s*\[/.test(head) && /\/Type\s*\/Sig\b/.test(head);
        if (security) showToast(`« ${name} » déverrouillé. La protection sera conservée à l’enregistrement.`);
        else if (tabDoc.signed) showToast(`« ${name} » contient une signature numérique : l’enregistrer de nouveau l’invalidera.`);
        setTabs((prev) => [...prev, tabDoc]);
        setActiveTabId(id);
        setSelectedOverlayId(null);
        setOrganizeMode(false);
        recordRecentFile(name);
      } catch {
        showToast(
          `Impossible d’ouvrir « ${name} » (fichier corrompu ou protégé par mot de passe).`
        );
      }
    },
    [showToast, recordRecentFile, askPassword]
  );

  // Load initial demo PDF on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      const sample = await createSamplePdf();
      if (mounted) {
        await openBytesInTab('Guide_F-pdf_Demo.pdf', sample);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [openBytesInTab]);

  // Warn before closing the window while a document has unsaved changes
  const hasUnsaved = tabs.some((t) => t.dirty);
  useEffect(() => {
    if (!hasUnsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsaved]);

  // Listen for Windows .pdf file association opens from Electron main process
  useEffect(() => {
    if (!window.fDesktop?.onFileOpened) return;
    return window.fDesktop.onFileOpened(({ name, bytes }) => {
      openBytesInTab(name, new Uint8Array(bytes));
    });
  }, [openBytesInTab]);

  // Reload PDF.js proxy when active tab or its underlying bytes change
  useEffect(() => {
    let cancelled = false;
    let activeTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    if (!activeTabBytes) {
      return () => {
        setPdfProxy(null);
      };
    }
    (async () => {
      try {
        const { task, doc } = await loadPdfWithTask(activeTabBytes);
        activeTask = task;
        if (!cancelled) {
          setPdfProxy(doc);
        } else {
          await task.destroy();
        }
      } catch (err) {
        console.error('Failed to load PDF', err);
      }
    })();
    return () => {
      cancelled = true;
      activeTask?.destroy();
    };
  }, [activeTabId, activeTabBytes]);

  // Overlay Undo/Redo mutations
  const pushUndoSnapshot = useCallback(() => {
    updateActiveTab((t) => ({
      ...t,
      undoStack: [...t.undoStack.slice(-29), t.overlays],
      redoStack: [],
    }));
  }, [updateActiveTab]);

  const handleAddOverlay = useCallback(
    (item: OverlayItem) => {
      updateActiveTab((t) => ({
        ...t,
        dirty: true,
        undoStack: [...t.undoStack.slice(-29), t.overlays],
        redoStack: [],
        overlays: [...t.overlays, item],
      }));
      if (
        [
          'text',
          'note',
          'stamp',
          'image',
          'signature',
          'yousign-zone',
          'form-text',
          'form-checkbox',
        ].includes(item.kind)
      ) {
        setActiveTool('select');
      }
    },
    [updateActiveTab]
  );

  const handleUpdateOverlay = useCallback(
    (id: string, patch: Partial<OverlayItem>) => {
      updateActiveTab((t) => ({
        ...t,
        dirty: true,
        overlays: t.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)),
      }));
    },
    [updateActiveTab]
  );

  const handleDeleteOverlay = useCallback(
    (id: string) => {
      updateActiveTab((t) => ({
        ...t,
        dirty: true,
        undoStack: [...t.undoStack.slice(-29), t.overlays],
        redoStack: [],
        overlays: t.overlays.filter((o) => o.id !== id),
      }));
      setSelectedOverlayId((prev) => (prev === id ? null : prev));
    },
    [updateActiveTab]
  );

  const handleUndo = useCallback(() => {
    updateActiveTab((t) => {
      if (t.undoStack.length === 0) return t;
      const previous = t.undoStack[t.undoStack.length - 1];
      return {
        ...t,
        dirty: true,
        overlays: previous,
        undoStack: t.undoStack.slice(0, -1),
        redoStack: [...t.redoStack, t.overlays],
      };
    });
  }, [updateActiveTab]);

  const handleRedo = useCallback(() => {
    updateActiveTab((t) => {
      if (t.redoStack.length === 0) return t;
      const next = t.redoStack[t.redoStack.length - 1];
      return {
        ...t,
        dirty: true,
        overlays: next,
        redoStack: t.redoStack.slice(0, -1),
        undoStack: [...t.undoStack, t.overlays],
      };
    });
  }, [updateActiveTab]);

  // `secure`: apply the password protection (only for the saved file: printing, image export
  // and Yousign need a readable PDF)
  const getBakedPdfBytes = useCallback(
    async (secure = false): Promise<Uint8Array> => {
      if (!activeTab) throw new Error('Aucun document actif');
      return bakeEditsToPdf(
        activeTab.bytes,
        activeTab.overlays,
        activeTab.watermark,
        activeTab.headerFooter,
        activeTab.purgeMetadata,
        {
          flattenAnnotations: activeTab.flattenAnnotations,
          security: secure ? activeTab.security : null,
        }
      );
    },
    [activeTab]
  );

  const handleSavePdf = useCallback(async () => {
    if (!activeTab) return;
    if (
      activeTab.signed &&
      !window.confirm('Ce document porte une signature numérique. L’enregistrer depuis F-pdf la rendra invalide. Continuer ?')
    ) {
      return;
    }
    try {
      const outBytes = await getBakedPdfBytes(true);
      if (window.fDesktop?.isElectron) {
        const res = await window.fDesktop.savePdfDialog(activeTab.name, outBytes);
        if (res.saved) {
          updateActiveTab((t) => ({ ...t, dirty: false }));
          showToast(`Document enregistré : ${res.filePath}`);
        }
      } else {
        const copy = new Uint8Array(outBytes);
        triggerDownload(new Blob([copy.buffer], { type: 'application/pdf' }), activeTab.name);
        updateActiveTab((t) => ({ ...t, dirty: false }));
        showToast(`PDF téléchargé : ${activeTab.name}`);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erreur lors de la sauvegarde PDF');
    }
  }, [activeTab, getBakedPdfBytes, showToast, updateActiveTab]);

  const handlePrint = useCallback(async () => {
    if (!activeTab) return;
    try {
      const baked = await getBakedPdfBytes();
      const copy = new Uint8Array(baked);
      const blobUrl = URL.createObjectURL(new Blob([copy.buffer], { type: 'application/pdf' }));
      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      iframe.src = blobUrl;
      iframe.onload = () => {
        setTimeout(() => {
          try {
            iframe.contentWindow?.focus();
            iframe.contentWindow?.print();
          } catch {
            window.print();
          }
          setTimeout(() => {
            iframe.remove();
            URL.revokeObjectURL(blobUrl);
          }, 60000);
        }, 250);
      };
      document.body.appendChild(iframe);
    } catch {
      showToast('Impossible de préparer l’impression PDF.');
    }
  }, [activeTab, getBakedPdfBytes, showToast]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSavePdf();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        handlePrint();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSidebarPanel('search');
        setSidebarCollapsed(false);
        return;
      }
      if (inEditable) return;

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedOverlayId) {
        handleDeleteOverlay(selectedOverlayId);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleRedo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedOverlayId, handleDeleteOverlay, handleUndo, handleRedo, handleSavePdf, handlePrint]);

  // File operations + Drag & Drop PDF
  const handleOpenFile = async () => {
    try {
      if (window.fDesktop?.isElectron) {
        const files = await window.fDesktop.openPdfDialog();
        for (const f of files) {
          await openBytesInTab(f.name, new Uint8Array(f.bytes));
        }
        return;
      }
      fileInputRef.current?.click();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erreur lors de l’ouverture du PDF.');
    }
  };

  const openDroppedFiles = async (fileList: FileList) => {
    for (const file of Array.from(fileList)) {
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        showToast(`Fichier ignoré (non PDF) : ${file.name}`);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        showToast(`${file.name} dépasse la limite de 100 Mo.`);
        continue;
      }
      const buf = await file.arrayBuffer();
      await openBytesInTab(file.name, new Uint8Array(buf));
    }
  };

  const handleBrowserFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      await openDroppedFiles(e.target.files);
    }
    e.target.value = '';
  };

  const handleCreateBlank = async () => {
    const bytes = await createBlankPdf();
    await openBytesInTab(`Nouveau_Document_${tabs.length + 1}.pdf`, bytes);
    showToast('Nouveau document PDF vierge créé.');
  };

  const handleCloseTab = (id: string) => {
    const target = tabs.find((t) => t.id === id);
    if (
      target?.dirty &&
      !window.confirm(
        `« ${target.name} » contient des modifications non enregistrées. Fermer quand même ?`
      )
    ) {
      return;
    }
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next[next.length - 1]?.id || '');
        if (next.length === 0) setPdfProxy(null);
      }
      return next;
    });
  };

  // Page organization with full overlay remapping & rotation
  const applyPageMutation = async (
    newBytes: Uint8Array,
    toastMsg: string,
    remapOverlays: (overlays: OverlayItem[]) => OverlayItem[],
    nextPage?: number
  ) => {
    try {
      const { task, doc } = await loadPdfWithTask(newBytes);
      const outline = await extractOutline(doc);
      const numPages = doc.numPages;
      await task.destroy();
      updateActiveTab((t) => ({
        ...t,
        bytes: newBytes,
        numPages,
        outline,
        dirty: true,
        overlays: remapOverlays(t.overlays),
        undoStack: [],
        redoStack: [],
        currentPage: Math.max(1, Math.min(numPages, nextPage ?? t.currentPage)),
      }));
      showToast(toastMsg);
    } catch {
      showToast('Erreur lors de la modification des pages du PDF.');
    }
  };

  const handleRotatePage = async (pageIndex: number, deg: number) => {
    if (!activeTab) return;
    const out = await rotatePdfPage(activeTab.bytes, pageIndex, deg);
    await applyPageMutation(
      out,
      `Page ${pageIndex + 1} pivotée (${deg > 0 ? '+90°' : '-90°'}).`,
      (overlays) => rotateOverlaysForPage(overlays, pageIndex, deg)
    );
  };

  const handleDeletePage = async (pageIndex: number) => {
    if (!activeTab || activeTab.numPages <= 1) {
      showToast('Un document doit contenir au moins une page.');
      return;
    }
    const out = await deletePdfPage(activeTab.bytes, pageIndex);
    await applyPageMutation(out, `Page ${pageIndex + 1} supprimée.`, (overlays) =>
      overlays
        .filter((o) => o.pageIndex !== pageIndex)
        .map((o) => (o.pageIndex > pageIndex ? { ...o, pageIndex: o.pageIndex - 1 } : o))
    );
  };

  const handleDuplicatePage = async (pageIndex: number) => {
    if (!activeTab) return;
    const out = await duplicatePdfPage(activeTab.bytes, pageIndex);
    await applyPageMutation(
      out,
      `Page ${pageIndex + 1} dupliquée.`,
      (overlays) => {
        const shifted = overlays.map((o) =>
          o.pageIndex > pageIndex ? { ...o, pageIndex: o.pageIndex + 1 } : o
        );
        const cloned = overlays
          .filter((o) => o.pageIndex === pageIndex)
          .map((o) => ({ ...o, id: crypto.randomUUID(), pageIndex: pageIndex + 1 }));
        return [...shifted, ...cloned];
      },
      pageIndex + 2
    );
  };

  const handleInsertBlankPage = async (afterIndex: number) => {
    if (!activeTab) return;
    const out = await insertBlankPdfPage(activeTab.bytes, afterIndex);
    await applyPageMutation(
      out,
      'Page vierge insérée.',
      (overlays) =>
        overlays.map((o) =>
          o.pageIndex > afterIndex ? { ...o, pageIndex: o.pageIndex + 1 } : o
        ),
      afterIndex + 2
    );
  };

  const handleReorderPages = async (fromIndex: number, toIndex: number) => {
    if (!activeTab || fromIndex === toIndex) return;
    const out = await reorderPdfPages(activeTab.bytes, fromIndex, toIndex);
    await applyPageMutation(
      out,
      `Page ${fromIndex + 1} déplacée en position ${toIndex + 1}.`,
      (overlays) =>
        overlays.map((o) => {
          if (o.pageIndex === fromIndex) return { ...o, pageIndex: toIndex };
          if (fromIndex < toIndex && o.pageIndex > fromIndex && o.pageIndex <= toIndex) {
            return { ...o, pageIndex: o.pageIndex - 1 };
          }
          if (fromIndex > toIndex && o.pageIndex >= toIndex && o.pageIndex < fromIndex) {
            return { ...o, pageIndex: o.pageIndex + 1 };
          }
          return o;
        }),
      toIndex + 1
    );
  };

  const handleMergePdf = async (file: File) => {
    if (!activeTab) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast('Le fichier PDF à fusionner dépasse 100 Mo.');
      return;
    }
    try {
      const otherBytes = new Uint8Array(await file.arrayBuffer());
      const merged = await mergePdfDocuments(activeTab.bytes, otherBytes);
      await applyPageMutation(merged, `PDF fusionné avec ${file.name}.`, (o) => o);
    } catch {
      showToast(`Impossible de fusionner « ${file.name} ».`);
    }
  };

  const handleExtractPages = async (indices: number[]) => {
    if (!activeTab || indices.length === 0) return;
    try {
      const baked = await getBakedPdfBytes();
      const extracted = await extractPdfPages(baked, indices);
      const base = activeTab.name.replace(/\.pdf$/i, '');
      await openBytesInTab(`${base}_extrait.pdf`, extracted);
      showToast(`${indices.length} page(s) extraite(s) avec vos annotations.`);
    } catch {
      showToast('Erreur lors de l’extraction des pages.');
    }
  };

  // Search
  const handleRunSearch = async () => {
    if (!pdfProxy || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const results = await searchPdfText(pdfProxy, searchQuery);
      setSearchResults(results);
    } finally {
      setSearching(false);
    }
  };

  // Export PNG / JPEG (with all edits baked in) & TXT
  const handleExportImage = async (format: 'png' | 'jpeg') => {
    if (!activeTab) return;
    try {
      const baked = await getBakedPdfBytes();
      const blob = await renderBakedPageToBlob(baked, activeTab.currentPage, format, 2);
      const base = activeTab.name.replace(/\.pdf$/i, '');
      triggerDownload(blob, `${base}_page${activeTab.currentPage}.${format}`);
      showToast(
        `Page ${activeTab.currentPage} exportée en ${format.toUpperCase()} (avec annotations).`
      );
    } catch {
      showToast(`Échec de l’export ${format.toUpperCase()}.`);
    }
  };

  const handleExportText = async () => {
    if (!pdfProxy || !activeTab) return;
    const txt = await extractAllText(pdfProxy, activeTab.overlays);
    const base = activeTab.name.replace(/\.pdf$/i, '');
    triggerDownload(new Blob([txt], { type: 'text/plain;charset=utf-8' }), `${base}.txt`);
    showToast('Texte du document exporté (.txt).');
  };

  // Local CSP-compliant OCR via bundled worker & WASM core
  const handleRunOcr = async () => {
    const canvas = activeCanvasRef.current;
    if (!canvas) {
      showToast('Veuillez afficher une page avant de lancer l’OCR.');
      return;
    }
    setOcrRunning(true);
    setOcrProgress(5);
    setOcrText('');
    try {
      const workerUrl = new URL('./tesseract/worker.min.js', window.location.href).href;
      const coreUrl = new URL('./tesseract/tesseract-core-lstm.wasm.js', window.location.href).href;
      const worker = await createWorker(ocrLang, 1, {
        workerPath: workerUrl,
        corePath: coreUrl,
        // Language models are bundled: OCR works offline, nothing is downloaded
        langPath: new URL('./tesseract/lang', window.location.href).href,
        workerBlobURL: false,
        logger: (m) => {
          if (m.status === 'recognizing text' && typeof m.progress === 'number') {
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
      });
      ocrWorkerRef.current = worker;
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      await worker.terminate();
      ocrWorkerRef.current = null;
      setOcrLines(ocrLinesFromResult(data, canvas.width, canvas.height));
      setOcrText(data.text.trim() || '(Aucun texte détecté sur cette page)');
      setOcrProgress(100);
      showToast('Reconnaissance OCR terminée.');
    } catch (err) {
      ocrWorkerRef.current = null;
      setOcrText(
        `Erreur OCR : ${err instanceof Error ? err.message : 'vérifiez l’accès aux modèles de langue Tesseract.'}`
      );
    } finally {
      setOcrRunning(false);
    }
  };

  // OCR of every page: adds a positioned, invisible text layer (searchable, selectable PDF)
  const handleRunOcrAllPages = async () => {
    if (!pdfProxy || !activeTab) return;
    const tabId = activeTab.id;
    const numPages = pdfProxy.numPages;
    setOcrRunning(true);
    setOcrProgress(0);
    setOcrText('');
    ocrCancelRef.current = false;
    const layers: OverlayItem[] = [];
    const texts: string[] = [];
    try {
      const worker = await createWorker(ocrLang, 1, {
        workerPath: new URL('./tesseract/worker.min.js', window.location.href).href,
        corePath: new URL('./tesseract/tesseract-core-lstm.wasm.js', window.location.href).href,
        langPath: new URL('./tesseract/lang', window.location.href).href,
        workerBlobURL: false,
      });
      ocrWorkerRef.current = worker;
      for (let p = 1; p <= numPages && !ocrCancelRef.current; p++) {
        setOcrText(`Page ${p} / ${numPages}…`);
        const page = await pdfProxy.getPage(p);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        const { data } = await worker.recognize(canvas, {}, { blocks: true });
        const lines = ocrLinesFromResult(data, canvas.width, canvas.height);
        texts.push(`--- Page ${p} ---\n${data.text.trim()}`);
        if (lines.length) {
          layers.push({
            id: crypto.randomUUID(),
            pageIndex: p - 1,
            kind: 'ocr-layer',
            x: 0.04,
            y: 0.04,
            w: 0.42,
            h: 0.04,
            color: '#10213a',
            lines,
            text: data.text,
            createdAt: new Date().toISOString(),
          });
        }
        setOcrProgress(Math.round((p / numPages) * 100));
      }
      await worker.terminate();
      ocrWorkerRef.current = null;
      if (ocrCancelRef.current) return;
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                dirty: true,
                undoStack: [...t.undoStack.slice(-29), t.overlays],
                redoStack: [],
                // Replace older OCR layers of these pages
                overlays: [
                  ...t.overlays.filter(
                    (o) => !(o.kind === 'ocr-layer' && layers.some((l) => l.pageIndex === o.pageIndex))
                  ),
                  ...layers,
                ],
              }
            : t
        )
      );
      setOcrLines([]);
      setOcrText(texts.join('\n\n'));
      showToast(`OCR terminé : ${layers.length} page(s) rendue(s) recherchables à l’enregistrement.`);
    } catch (err) {
      setOcrText(`Erreur OCR : ${err instanceof Error ? err.message : 'échec de la reconnaissance.'}`);
    } finally {
      ocrWorkerRef.current = null;
      setOcrRunning(false);
    }
  };

  const handleExportDocx = async () => {
    if (!pdfProxy || !activeTab) return;
    try {
      showToast('Export Word en cours…');
      // Convert the document with its edits (annotations, edited text...)
      const { task, doc } = await loadPdfWithTask(await getBakedPdfBytes());
      let blob: Blob;
      try {
        blob = await convertPdfToDocx(doc);
      } finally {
        await task.destroy();
      }
      triggerDownload(blob, `${activeTab.name.replace(/\.pdf$/i, '')}.docx`);
      showToast('Document Word exporté : paragraphes, titres, styles, tableaux et images.');
    } catch (err) {
      showToast(err instanceof Error ? `Export Word impossible : ${err.message}` : 'Export Word impossible.');
    }
  };

  const handleCompareWith = async (file: File) => {
    if (!pdfProxy || !activeTab) return;
    setCompare({ otherName: file.name, result: null, error: null });
    try {
      if (file.size > MAX_UPLOAD_BYTES) throw new Error('Le fichier dépasse 100 Mo.');
      const { task, doc } = await loadPdfWithTask(new Uint8Array(await file.arrayBuffer()));
      try {
        const result = await comparePdfDocuments(pdfProxy, doc);
        setCompare({ otherName: file.name, result, error: null });
      } finally {
        await task.destroy();
      }
    } catch (err) {
      setCompare({
        otherName: file.name,
        result: null,
        error: isPasswordError(err)
          ? 'Ce PDF est protégé : ouvrez-le d’abord dans F-pdf, enregistrez-le sans protection, puis comparez.'
          : err instanceof Error
            ? err.message
            : 'Comparaison impossible.',
      });
    }
  };

  // ----- Digital signature with a certificate -----
  const cleanIpcError = (e: unknown) =>
    (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  const handlePlaceCertZone = (draft: Partial<CertSignRequest>) => {
    certDraftRef.current = draft;
    setCertModal(null);
    setRibbonTab('form');
    setActiveTool('cert-zone');
    showToast('Cliquez sur la page à l’endroit où la signature doit apparaître.');
  };

  const handleCertZonePlaced = (zone: OverlayItem) => {
    // Only one signature zone: drop the previous ones
    updateActiveTab((t) => ({
      ...t,
      overlays: t.overlays.filter((o) => o.kind !== 'cert-zone' || o.id === zone.id),
    }));
    setCertModal({ draft: certDraftRef.current, busy: false, error: null });
  };

  const handleCertSign = async (req: CertSignRequest) => {
    const api = window.fDesktop?.certificates;
    if (!activeTab || !api) return;
    if (activeTab.security) {
      setCertModal((m) => m && { ...m, error: 'Retirez d’abord la protection par mot de passe (bouton Protéger) : ce PDF ne peut pas être chiffré et signé en même temps ici.' });
      return;
    }
    setCertModal((m) => m && { ...m, busy: true, error: null, draft: req });
    try {
      let bytes = await getBakedPdfBytes(false);
      let rect: [number, number, number, number] | null = null;
      let pageIndex = activeTab.currentPage - 1;
      const zone = activeTab.overlays.filter((o) => o.kind === 'cert-zone').at(-1);
      if (req.visible && zone) {
        const now = new Date();
        const drawn = await drawCertificateAppearance(bytes, zone, {
          name: `Signé numériquement par ${req.info.name}`,
          details: [
            `Date : ${now.toLocaleDateString('fr-FR')} ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`,
            req.reason ? `Motif : ${req.reason}` : '',
            req.location ? `Lieu : ${req.location}` : '',
          ].filter(Boolean),
        });
        bytes = drawn.bytes;
        rect = drawn.rect;
        pageIndex = zone.pageIndex;
      }
      const signed = await api.sign({
        id: req.cert.id,
        password: req.password,
        pdfBytes: bytes,
        reason: req.reason,
        location: req.location,
        contact: req.contact,
        pageIndex,
        rect,
      });
      const fileName = `${activeTab.name.replace(/\.pdf$/i, '')} - signé.pdf`;
      const saved = await window.fDesktop!.savePdfDialog(fileName, signed.bytes);
      if (saved.saved) {
        setCertModal(null);
        certDraftRef.current = null;
        updateActiveTab((t) => ({ ...t, overlays: t.overlays.filter((o) => o.kind !== 'cert-zone') }));
        showToast(`Document signé par ${signed.signerName} et enregistré : ${saved.filePath}. Ne le modifiez plus.`);
      } else {
        setCertModal((m) => m && { ...m, busy: false });
      }
    } catch (e) {
      setCertModal((m) => m && { ...m, busy: false, error: `Signature impossible : ${cleanIpcError(e)}` });
    }
  };

  const handleCloseOcrDrawer = async () => {
    ocrCancelRef.current = true;
    if (ocrWorkerRef.current) {
      try {
        await ocrWorkerRef.current.terminate();
      } catch {
        // ignore
      }
      ocrWorkerRef.current = null;
    }
    setOcrRunning(false);
    setOcrText('');
  };

  // Signature & Image pickers
  const handleSelectSignature = (dataUrl: string, label: string) => {
    setPendingSignatureDataUrl(dataUrl);
    setActiveTool('signature');
    setSavedSignatures((prev) => {
      if (prev.some((s) => s.dataUrl === dataUrl)) return prev;
      const next = [{ id: crypto.randomUUID(), label, dataUrl }, ...prev].slice(0, 6);
      persistSignatures(next);
      return next;
    });
    showToast('Cliquez sur le document pour placer votre signature.');
  };

  const handleDeleteSavedSignature = (id: string) => {
    setSavedSignatures((prev) => {
      const next = prev.filter((s) => s.id !== id);
      persistSignatures(next);
      return next;
    });
  };

  const handlePickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      showToast('L’image dépasse 8 Mo.');
      e.target.value = '';
      return;
    }
    try {
      const safeDataUrl = await normalizeImageFileToDataUrl(file);
      setPendingImageDataUrl(safeDataUrl);
      setActiveTool('image');
      showToast('Cliquez sur la page pour insérer l’image.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Format image non supporté.');
    } finally {
      e.target.value = '';
    }
  };

  const handleOpenYousignModal = () => {
    setYousignModalKey((k) => k + 1);
    setYousignModalOpen(true);
  };

  const handleYousignZonePlaced = (zone: YousignPlacedZone) => {
    setPlacedYousignZone(zone);
    setYousignModalKey((k) => k + 1);
    setYousignModalOpen(true);
    showToast(`Zone Yousign positionnée (p.${zone.page}, X:${zone.x}, Y:${zone.y}).`);
  };

  const handleApplyDemoYousignStamp = (signerName: string, email: string) => {
    if (!activeTab) return;
    handleAddOverlay({
      id: crypto.randomUUID(),
      pageIndex: activeTab.currentPage - 1,
      kind: 'note',
      x: 0.08,
      y: 0.72,
      w: 0.42,
      h: 0.1,
      color: '#10213a',
      text: `DÉMO YOUSIGN — NON SIGNÉ — Simulation pour ${signerName} (${email}) le ${new Date().toLocaleDateString('fr-FR')}`,
      createdAt: new Date().toISOString(),
    });
    showToast('Demande Yousign créée et cachet de suivi apposé.');
  };

  // Hand tool pan + Ctrl+Wheel zoom
  const onScrollerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool !== 'hand' || !scrollerRef.current) return;
    panStateRef.current = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: scrollerRef.current.scrollLeft,
      scrollTop: scrollerRef.current.scrollTop,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onScrollerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panStateRef.current || !scrollerRef.current) return;
    scrollerRef.current.scrollLeft =
      panStateRef.current.scrollLeft - (e.clientX - panStateRef.current.x);
    scrollerRef.current.scrollTop =
      panStateRef.current.scrollTop - (e.clientY - panStateRef.current.y);
  };

  const onScrollerPointerUp = () => {
    panStateRef.current = null;
  };

  const onScrollerWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey || !hasDoc) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    updateActiveTab((t) => ({
      ...t,
      zoom: Math.max(0.5, Math.min(2.6, +(t.zoom + delta).toFixed(2))),
    }));
  };

  const selectedOverlay =
    activeTab?.overlays.find((o) => o.id === selectedOverlayId) || null;

  return (
    <div
      className={`app-shell ${darkMode ? 'theme-dark' : 'theme-light'} ${dragOverFile ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOverFile(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOverFile(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOverFile(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          openDroppedFiles(e.dataTransfer.files);
        }
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        multiple
        hidden
        onChange={handleBrowserFileChange}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={handlePickImage}
      />

      {/* Top Window Chrome & Document Tab Strip */}
      <header className="titlebar">
        <div className="brand-block">
          <img className="brand-badge" src="./favicon.svg" alt="" aria-hidden="true" />
          <h1 className="brand-title">F-pdf</h1>
        </div>

        <div className="quick-access">
          <button
            className="qa-btn"
            onClick={handleOpenFile}
            title="Ouvrir un PDF"
            aria-label="Ouvrir un PDF"
          >
            <FolderOpen size={15} />
          </button>
          <button
            className="qa-btn"
            onClick={handleSavePdf}
            disabled={!hasDoc}
            title="Enregistrer le PDF (Ctrl+S)"
            aria-label="Enregistrer le PDF"
          >
            <Save size={15} />
          </button>
          <button
            className="qa-btn"
            onClick={handleUndo}
            disabled={!activeTab || activeTab.undoStack.length === 0}
            title="Annuler (Ctrl+Z)"
            aria-label="Annuler"
          >
            <Undo2 size={15} />
          </button>
          <button
            className="qa-btn"
            onClick={handleRedo}
            disabled={!activeTab || activeTab.redoStack.length === 0}
            title="Rétablir (Ctrl+Y)"
            aria-label="Rétablir"
          >
            <Redo2 size={15} />
          </button>
          <button
            className="qa-btn"
            onClick={handlePrint}
            disabled={!hasDoc}
            title="Imprimer le PDF (Ctrl+P)"
            aria-label="Imprimer le PDF"
          >
            <Printer size={15} />
          </button>
        </div>

        <div className="doc-tabs" role="tablist" aria-label="Documents ouverts">
          {tabs.map((tab) => (
            <div key={tab.id} className={`doc-tab ${tab.id === activeTabId ? 'active' : ''}`}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeTabId}
                className="doc-tab-select"
                onClick={() => {
                  setActiveTabId(tab.id);
                  setSelectedOverlayId(null);
                }}
              >
                <FileText size={13} />
                <span className="doc-tab-name">
                  {tab.name}
                  {tab.dirty ? ' *' : ''}
                </span>
              </button>
              <button
                type="button"
                className="doc-tab-close"
                onClick={() => handleCloseTab(tab.id)}
                aria-label={`Fermer ${tab.name}`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            className="doc-tab-add"
            onClick={handleCreateBlank}
            title="Nouveau PDF vierge"
            aria-label="Nouveau PDF vierge"
          >
            +
          </button>
        </div>

        <div className="titlebar-right">
          <button
            className="yousign-top-pill"
            onClick={handleOpenYousignModal}
            disabled={!hasDoc}
            title="Envoyer pour signature électronique Yousign eIDAS"
          >
            <ShieldCheck size={15} />
            <span>Yousign</span>
          </button>
          <button
            className="qa-btn"
            onClick={() => setDarkMode((d) => !d)}
            title={darkMode ? 'Mode clair' : 'Mode sombre'}
            aria-label={darkMode ? 'Activer le mode clair' : 'Activer le mode sombre'}
          >
            {darkMode ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </header>

      {/* Ribbon Bar */}
      <nav className="ribbon-container" aria-label="Ruban d’outils">
        <div className="ribbon-tabs" role="tablist">
          {(
            [
              ['home', 'Accueil'],
              ['comment', 'Commentaire'],
              ['edit', 'Éditer'],
              ['organize', 'Organiser'],
              ['form', 'Formulaire & Signer'],
              ['ocr', 'Convertir & OCR'],
            ] as Array<[RibbonTab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={ribbonTab === key}
              className={`ribbon-tab-btn ${ribbonTab === key ? 'active' : ''}`}
              onClick={() => {
                setRibbonTab(key);
                if (key !== 'organize') setOrganizeMode(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ribbon-strip">
          {ribbonTab === 'home' && (
            <>
              <div className="ribbon-group">
                <button
                  className={`tool-btn ${activeTool === 'select' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('select')}
                >
                  <MousePointer2 size={18} />
                  <span>Sélection</span>
                </button>
                <button
                  className={`tool-btn ${activeTool === 'hand' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('hand')}
                >
                  <Hand size={18} />
                  <span>Main</span>
                </button>
              </div>
              <div className="ribbon-sep" />
              <div className="ribbon-group">
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() =>
                    updateActiveTab((t) => ({
                      ...t,
                      zoom: Math.max(0.5, +(t.zoom - 0.15).toFixed(2)),
                    }))
                  }
                >
                  <ZoomOut size={18} />
                  <span>Zoom -</span>
                </button>
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() =>
                    updateActiveTab((t) => ({
                      ...t,
                      zoom: Math.min(2.6, +(t.zoom + 0.15).toFixed(2)),
                    }))
                  }
                >
                  <ZoomIn size={18} />
                  <span>Zoom +</span>
                </button>
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() => updateActiveTab((t) => ({ ...t, zoom: 1.15 }))}
                >
                  <Layers size={18} />
                  <span>Ajuster</span>
                </button>
              </div>
              <div className="ribbon-sep" />
              <div className="ribbon-group">
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() =>
                    activeTab && handleRotatePage(activeTab.currentPage - 1, -90)
                  }
                >
                  <RotateCcw size={18} />
                  <span>Pivoter G</span>
                </button>
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() =>
                    activeTab && handleRotatePage(activeTab.currentPage - 1, 90)
                  }
                >
                  <RotateCw size={18} />
                  <span>Pivoter D</span>
                </button>
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() => {
                    setSidebarPanel('search');
                    setSidebarCollapsed(false);
                  }}
                >
                  <Search size={18} />
                  <span>Rechercher</span>
                </button>
              </div>
              <div className="ribbon-sep" />
              <div className="ribbon-group">
                <button
                  className="tool-btn primary-accent"
                  disabled={!hasDoc}
                  onClick={handleSavePdf}
                >
                  <Save size={18} />
                  <span>Enregistrer PDF</span>
                </button>
                <button
                  className={`tool-btn ${activeTab?.security ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setSecurityOpen(true)}
                  title="Protéger le PDF par mot de passe (AES-256) et limiter impression, copie, modification"
                >
                  <Lock size={18} />
                  <span>{activeTab?.security ? 'Protégé' : 'Protéger'}</span>
                </button>
              </div>
            </>
          )}

          {ribbonTab === 'comment' && (
            <>
              <div className="ribbon-group">
                <button
                  className={`tool-btn ${activeTool === 'highlight' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => {
                    setToolColor('#eab308');
                    setActiveTool('highlight');
                  }}
                >
                  <Highlighter size={18} />
                  <span>Surligner</span>
                </button>
                <button
                  className={`tool-btn ${activeTool === 'draw' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('draw')}
                >
                  <Pen size={18} />
                  <span>Stylo</span>
                </button>
                <button
                  className={`tool-btn ${activeTool === 'rect' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('rect')}
                >
                  <Square size={18} />
                  <span>Rectangle</span>
                </button>
                <button
                  className={`tool-btn ${activeTool === 'ellipse' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('ellipse')}
                >
                  <Circle size={18} />
                  <span>Ellipse</span>
                </button>
                <button
                  className={`tool-btn ${activeTool === 'arrow' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('arrow')}
                >
                  <ArrowRight size={18} />
                  <span>Flèche</span>
                </button>
                <button
                  className={`tool-btn ${activeTool === 'note' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('note')}
                >
                  <StickyNote size={18} />
                  <span>Note</span>
                </button>
              </div>
              <div className="ribbon-sep" />
              <div className="ribbon-group">
                <button
                  className={`tool-btn ${activeTool === 'stamp' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('stamp')}
                >
                  <Stamp size={18} />
                  <span>Tampon</span>
                </button>
                <select
                  className="ribbon-select"
                  aria-label="Modèle de tampon"
                  disabled={!hasDoc}
                  value={stampPreset}
                  onChange={(e) => {
                    setStampPreset(e.target.value as StampPreset);
                    setActiveTool('stamp');
                  }}
                >
                  {STAMP_PRESETS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ribbon-sep" />
              <div className="ribbon-group">
                <div className="color-picker-inline">
                  {COLOR_PALETTE.map((c) => (
                    <button
                      key={c}
                      className={`color-dot ${toolColor === c ? 'selected' : ''}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setToolColor(c)}
                      title={`Couleur ${c}`}
                      aria-label={`Sélectionner la couleur ${c}`}
                    />
                  ))}
                </div>
                <label className="ribbon-range">
                  <span>Trait</span>
                  <input
                    type="range"
                    aria-label="Épaisseur du trait"
                    min={1}
                    max={8}
                    step={0.5}
                    value={strokeWidth}
                    onChange={(e) => setStrokeWidth(Number(e.target.value))}
                  />
                </label>
              </div>
            </>
          )}

          {ribbonTab === 'edit' && (
            <>
              <div className="ribbon-group">
                <button
                  className={`tool-btn ${activeTool === 'text' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('text')}
                >
                  <Type size={18} />
                  <span>Ajouter texte</span>
                </button>
                <button
                  className={`tool-btn ${activeTool === 'edit-text' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => {
                    setActiveTool('edit-text');
                    showToast('Cliquez sur une ligne de texte du PDF pour la modifier.');
                  }}
                  title="Modifier une ligne de texte existante du PDF"
                >
                  <PencilLine size={18} />
                  <span>Modifier texte</span>
                </button>
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() => imageInputRef.current?.click()}
                >
                  <ImagePlus size={18} />
                  <span>Insérer image</span>
                </button>
                <button
                  className={`tool-btn ${activeTool === 'redact' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('redact')}
                  title="Caviarder définitivement une zone sensible. À l’enregistrement, la page concernée devient une image : le texte caché est réellement supprimé."
                >
                  <EyeOff size={18} />
                  <span>Caviarder</span>
                </button>
                <label className="ribbon-inline-field">
                  <span>Taille</span>
                  <input
                    type="number"
                    min={8}
                    max={48}
                    className="mini-num"
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value) || 14)}
                  />
                </label>
                {selectedOverlay?.kind === 'text' && (
                  <button
                    className={`tool-btn ${selectedOverlay.bold ? 'active' : ''}`}
                    onClick={() => {
                      pushUndoSnapshot();
                      handleUpdateOverlay(selectedOverlay.id, {
                        bold: !selectedOverlay.bold,
                      });
                    }}
                  >
                    <Bold size={18} />
                    <span>Gras</span>
                  </button>
                )}
              </div>
              <div className="ribbon-sep" />
              {activeTab && (
                <div className="ribbon-group">
                  <label className="ribbon-toggle">
                    <input
                      type="checkbox"
                      checked={activeTab.watermark.enabled}
                      onChange={(e) =>
                        updateActiveTab((t) => ({
                          ...t,
                          dirty: true,
                          watermark: { ...t.watermark, enabled: e.target.checked },
                        }))
                      }
                    />
                    <span>Filigrane</span>
                  </label>
                  <input
                    className="ribbon-input"
                    aria-label="Texte du filigrane"
                    value={activeTab.watermark.text}
                    onChange={(e) =>
                      updateActiveTab((t) => ({
                        ...t,
                        dirty: true,
                        watermark: { ...t.watermark, text: e.target.value },
                      }))
                    }
                    placeholder="Texte filigrane"
                  />
                  <label className="ribbon-toggle">
                    <input
                      type="checkbox"
                      checked={activeTab.headerFooter.enabled}
                      onChange={(e) =>
                        updateActiveTab((t) => ({
                          ...t,
                          dirty: true,
                          headerFooter: {
                            ...t.headerFooter,
                            enabled: e.target.checked,
                          },
                        }))
                      }
                    />
                    <span>En-tête / Pied</span>
                  </label>
                  <label
                    className="ribbon-toggle"
                    title="Supprime Auteur, Titre et Logiciel lors de l’export PDF"
                  >
                    <input
                      type="checkbox"
                      checked={activeTab.purgeMetadata}
                      onChange={(e) =>
                        updateActiveTab((t) => ({
                          ...t,
                          dirty: true,
                          purgeMetadata: e.target.checked,
                        }))
                      }
                    />
                    <span>Purger métadonnées</span>
                  </label>
                  <label
                    className="ribbon-toggle"
                    title="Coché : les annotations sont fondues dans la page. Décoché : vraies annotations PDF, modifiables dans Acrobat, Foxit et F-pdf"
                  >
                    <input
                      type="checkbox"
                      checked={activeTab.flattenAnnotations}
                      onChange={(e) =>
                        updateActiveTab((t) => ({
                          ...t,
                          dirty: true,
                          flattenAnnotations: e.target.checked,
                        }))
                      }
                    />
                    <span>Aplatir annotations</span>
                  </label>
                </div>
              )}
            </>
          )}

          {ribbonTab === 'organize' && (
            <>
              <div className="ribbon-group">
                <button
                  className={`tool-btn ${organizeMode ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setOrganizeMode((m) => !m)}
                >
                  <Grid size={18} />
                  <span>Vue Grille</span>
                </button>
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() =>
                    activeTab && handleInsertBlankPage(activeTab.currentPage - 1)
                  }
                >
                  <FilePlus2 size={18} />
                  <span>Page vierge</span>
                </button>
                <label className={`tool-btn ${!hasDoc ? 'disabled' : ''}`}>
                  <FolderPlus size={18} />
                  <span>Fusionner PDF</span>
                  <input
                    type="file"
                    accept="application/pdf"
                    disabled={!hasDoc}
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleMergePdf(f);
                      e.target.value = '';
                    }}
                  />
                </label>
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() =>
                    activeTab && handleExtractPages([activeTab.currentPage - 1])
                  }
                >
                  <Scissors size={18} />
                  <span>Extraire page</span>
                </button>
                <label
                  className={`tool-btn ${!hasDoc ? 'disabled' : ''}`}
                  title="Comparer le texte de ce document avec un autre PDF"
                >
                  <GitCompare size={18} />
                  <span>Comparer</span>
                  <input
                    type="file"
                    accept="application/pdf"
                    disabled={!hasDoc}
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleCompareWith(f);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              <div className="ribbon-sep" />
              <div className="ribbon-group">
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() =>
                    activeTab && handleDuplicatePage(activeTab.currentPage - 1)
                  }
                >
                  <Copy size={18} />
                  <span>Dupliquer</span>
                </button>
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() =>
                    activeTab && handleRotatePage(activeTab.currentPage - 1, 90)
                  }
                >
                  <RotateCw size={18} />
                  <span>Pivoter +90°</span>
                </button>
                <button
                  className="tool-btn danger-text"
                  disabled={!hasDoc}
                  onClick={() =>
                    activeTab && handleDeletePage(activeTab.currentPage - 1)
                  }
                >
                  <Trash2 size={18} />
                  <span>Supprimer</span>
                </button>
              </div>
            </>
          )}

          {ribbonTab === 'form' && (
            <>
              <div className="ribbon-group">
                <button
                  className={`tool-btn ${activeTool === 'form-text' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('form-text')}
                  title="Champ texte AcroForm natif remplissable"
                >
                  <TextCursorInput size={18} />
                  <span>Champ AcroForm</span>
                </button>
                <button
                  className={`tool-btn ${activeTool === 'form-checkbox' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setActiveTool('form-checkbox')}
                  title="Case à cocher AcroForm native"
                >
                  <CheckSquare size={18} />
                  <span>Case AcroForm</span>
                </button>
                <button
                  className={`tool-btn ${activeTool === 'signature' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setSigModalOpen(true)}
                >
                  <PenTool size={18} />
                  <span>Signature locale</span>
                </button>
                <button
                  className={`tool-btn ${activeTool === 'cert-zone' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => setCertModal({ draft: certDraftRef.current, busy: false, error: null })}
                  title="Signer avec un certificat numérique (.pfx / .p12), vérifiable dans Acrobat et Foxit"
                >
                  <FileBadge size={18} />
                  <span>Signature certificat</span>
                </button>
              </div>
              <div className="ribbon-sep" />
              <div className="ribbon-group">
                <button
                  className={`tool-btn ${activeTool === 'yousign-zone' ? 'active' : ''}`}
                  disabled={!hasDoc}
                  onClick={() => {
                    setActiveTool('yousign-zone');
                    showToast('Cliquez sur la page pour placer visuellement la zone Yousign.');
                  }}
                >
                  <Crosshair size={18} />
                  <span>Zone Yousign</span>
                </button>
                <button
                  className="tool-btn yousign-ribbon-btn"
                  disabled={!hasDoc}
                  onClick={handleOpenYousignModal}
                >
                  <ShieldCheck size={18} />
                  <span>Envoyer via Yousign</span>
                </button>
              </div>
              <div className="ribbon-sep" />
              <div className="ribbon-group">
                <button className="tool-btn" disabled={!hasDoc} onClick={handleSavePdf}>
                  <Download size={18} />
                  <span>Exporter PDF</span>
                </button>
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() => handleExportImage('png')}
                >
                  <FileImage size={18} />
                  <span>Export PNG</span>
                </button>
              </div>
            </>
          )}

          {ribbonTab === 'ocr' && (
            <>
              <div className="ribbon-group">
                <select
                  className="ribbon-select"
                  aria-label="Langue OCR"
                  disabled={!hasDoc}
                  value={ocrLang}
                  onChange={(e) => setOcrLang(e.target.value as 'fra' | 'eng')}
                >
                  <option value="fra">OCR Français</option>
                  <option value="eng">OCR English</option>
                </select>
                <button
                  className="tool-btn primary-accent"
                  onClick={handleRunOcr}
                  disabled={!hasDoc || ocrRunning}
                >
                  <ScanText size={18} />
                  <span>{ocrRunning ? `OCR ${ocrProgress}%` : 'Lancer OCR page'}</span>
                </button>
                <button
                  className="tool-btn"
                  onClick={handleRunOcrAllPages}
                  disabled={!hasDoc || ocrRunning}
                  title="Reconnaît toutes les pages et rend le PDF recherchable (couche texte invisible)"
                >
                  <ScanSearch size={18} />
                  <span>OCR document entier</span>
                </button>
              </div>
              <div className="ribbon-sep" />
              <div className="ribbon-group">
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() => handleExportImage('png')}
                >
                  <FileImage size={18} />
                  <span>Page en PNG</span>
                </button>
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={() => handleExportImage('jpeg')}
                >
                  <FileImage size={18} />
                  <span>Page en JPEG</span>
                </button>
                <button className="tool-btn" disabled={!hasDoc} onClick={handleExportText}>
                  <FileText size={18} />
                  <span>Tout le texte (.txt)</span>
                </button>
                <button
                  className="tool-btn"
                  disabled={!hasDoc}
                  onClick={handleExportDocx}
                  title="Exporte le texte vers Word (.docx) : paragraphes et titres, sans la mise en page"
                >
                  <FileType2 size={18} />
                  <span>Exporter Word</span>
                </button>
              </div>
            </>
          )}
        </div>
      </nav>

      {/* Main Workspace */}
      <div className="workspace-body">
        {activeTab && (
          <Sidebar
            pdfDoc={pdfProxy}
            numPages={activeTab.numPages}
            currentPage={activeTab.currentPage}
            activePanel={sidebarPanel}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
            onChangePanel={setSidebarPanel}
            onSelectPage={(p) => {
              setOrganizeMode(false);
              updateActiveTab((t) => ({ ...t, currentPage: p }));
            }}
            onReorderPage={handleReorderPages}
            onRotatePage={(i) => handleRotatePage(i, 90)}
            onDeletePage={handleDeletePage}
            outline={activeTab.outline}
            overlays={activeTab.overlays}
            onSelectOverlay={(item) => {
              setOrganizeMode(false);
              updateActiveTab((t) => ({ ...t, currentPage: item.pageIndex + 1 }));
              setSelectedOverlayId(item.id);
            }}
            onDeleteOverlay={handleDeleteOverlay}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onRunSearch={handleRunSearch}
            searchResults={searchResults}
            searching={searching}
          />
        )}

        <main className="editor-stage">
          {!activeTab ? (
            <div className="empty-workspace">
              <FileText size={48} />
              <h2>Aucun document ouvert</h2>
              <p>
                Glissez-déposez un fichier PDF ici, ouvrez un fichier existant ou créez un nouveau
                document vierge dans <strong>F-pdf</strong>.
              </p>
              <div className="empty-actions">
                <button className="btn-primary" onClick={handleOpenFile}>
                  <FolderOpen size={16} /> Ouvrir un PDF
                </button>
                <button className="btn-secondary" onClick={handleCreateBlank}>
                  <FilePlus2 size={16} /> Nouveau PDF vierge
                </button>
              </div>
              {recentFiles.length > 0 && (
                <div className="recent-files-box">
                  <strong>Documents récents :</strong>
                  <span>{recentFiles.join(' · ')}</span>
                </div>
              )}
            </div>
          ) : organizeMode ? (
            <OrganizeView
              pdfDoc={pdfProxy}
              numPages={activeTab.numPages}
              onRotate={handleRotatePage}
              onDelete={handleDeletePage}
              onDuplicate={handleDuplicatePage}
              onInsertBlank={handleInsertBlankPage}
              onReorder={handleReorderPages}
              onExtractSelected={handleExtractPages}
              onMergePdfFile={handleMergePdf}
              onOpenPage={(p) => {
                updateActiveTab((t) => ({ ...t, currentPage: p }));
                setOrganizeMode(false);
              }}
            />
          ) : (
            <div
              ref={scrollerRef}
              className={`canvas-scroller ${activeTool === 'hand' ? 'cursor-grab' : ''}`}
              onPointerDown={onScrollerPointerDown}
              onPointerMove={onScrollerPointerMove}
              onPointerUp={onScrollerPointerUp}
              onWheel={onScrollerWheel}
            >
              <PageCanvas
                pdfDoc={pdfProxy}
                pageNumber={activeTab.currentPage}
                numPages={activeTab.numPages}
                zoom={activeTab.zoom}
                activeTool={activeTool}
                toolColor={toolColor}
                strokeWidth={strokeWidth}
                fontSize={fontSize}
                stampPreset={stampPreset}
                pendingImageDataUrl={pendingImageDataUrl}
                pendingSignatureDataUrl={pendingSignatureDataUrl}
                overlays={activeTab.overlays}
                selectedId={selectedOverlayId}
                watermark={activeTab.watermark}
                headerFooter={activeTab.headerFooter}
                onSelectOverlay={setSelectedOverlayId}
                onBeforeMutate={pushUndoSnapshot}
                onAddOverlay={handleAddOverlay}
                onUpdateOverlay={handleUpdateOverlay}
                onDeleteOverlay={handleDeleteOverlay}
                onYousignZonePlaced={handleYousignZonePlaced}
                onCanvasReady={handleCanvasReady}
                onToast={showToast}
                onCertZonePlaced={handleCertZonePlaced}
              />
            </div>
          )}
        </main>

        {/* Contextual OCR Result Drawer */}
        {(ocrRunning || ocrText) && (
          <aside className="right-panel">
            <div className="right-panel-head">
              <strong>Résultat OCR ({ocrLang.toUpperCase()})</strong>
              <button
                className="icon-btn"
                onClick={handleCloseOcrDrawer}
                title="Fermer / Annuler l’OCR"
                aria-label="Fermer le panneau OCR"
              >
                <X size={15} />
              </button>
            </div>
            {ocrRunning && (
              <div className="ocr-progress-wrap">
                <div className="ocr-progress-bar">
                  <div style={{ width: `${ocrProgress}%` }} />
                </div>
                <span>Analyse en cours… {ocrProgress}%</span>
              </div>
            )}
            <textarea
              className="ocr-textarea"
              aria-label="Texte extrait par OCR"
              value={ocrText}
              onChange={(e) => setOcrText(e.target.value)}
              placeholder="Le texte reconnu apparaîtra ici…"
            />
            <div className="right-panel-actions">
              <button
                className="btn-secondary btn-sm"
                onClick={() => {
                  navigator.clipboard
                    .writeText(ocrText)
                    .then(() => showToast('Texte OCR copié dans le presse-papiers.'))
                    .catch(() => showToast('Accès au presse-papiers refusé.'));
                }}
              >
                <Copy size={13} /> Copier
              </button>
              <button
                className="btn-secondary btn-sm"
                title="Injecte le texte OCR en couche invisible dans le PDF pour le rendre recherchable"
                onClick={() => {
                  if (!activeTab || !ocrText.trim()) return;
                  handleAddOverlay({
                    id: crypto.randomUUID(),
                    pageIndex: activeTab.currentPage - 1,
                    kind: 'ocr-layer',
                    x: 0.04,
                    y: 0.04,
                    w: 0.42,
                    h: 0.04,
                    color: '#10213a',
                    text: ocrText,
                    lines: ocrLines.length ? ocrLines : undefined,
                    createdAt: new Date().toISOString(),
                  });
                  showToast('Couche OCR invisible ajoutée (PDF recherchable à l’export).');
                }}
              >
                <Eraser size={13} /> Couche invisible
              </button>
              <button
                className="btn-primary btn-sm"
                onClick={() => {
                  if (!activeTab || !ocrText.trim()) return;
                  handleAddOverlay({
                    id: crypto.randomUUID(),
                    pageIndex: activeTab.currentPage - 1,
                    kind: 'text',
                    x: 0.08,
                    y: 0.1,
                    w: 0.84,
                    h: 0.25,
                    color: '#111827',
                    fontSize: 11,
                    text: ocrText,
                    createdAt: new Date().toISOString(),
                  });
                  showToast('Texte OCR inséré sur la page.');
                }}
              >
                Insérer texte
              </button>
            </div>
          </aside>
        )}
      </div>

      {pwPrompt && (
        <PasswordPromptModal
          key={`${pwPrompt.fileName}-${pwPrompt.error ?? ''}`}
          fileName={pwPrompt.fileName}
          error={pwPrompt.error}
          onSubmit={(pw) => {
            pwPrompt.resolve(pw);
            setPwPrompt(null);
          }}
        />
      )}

      {securityOpen && activeTab && (
        <SecurityModal
          current={activeTab.security}
          onClose={() => setSecurityOpen(false)}
          onApply={(sec) => {
            updateActiveTab((t) => ({ ...t, dirty: true, security: sec }));
            setSecurityOpen(false);
            showToast(
              sec
                ? 'Protection activée : elle sera appliquée à l’enregistrement du PDF.'
                : 'Protection retirée : le PDF sera enregistré sans mot de passe.'
            );
          }}
        />
      )}

      {certModal && activeTab && (
        <CertSignModal
          initial={certModal.draft}
          busy={certModal.busy}
          error={certModal.error}
          hasZone={activeTab.overlays.some((o) => o.kind === 'cert-zone')}
          zonePage={(() => {
            const z = activeTab.overlays.filter((o) => o.kind === 'cert-zone').at(-1);
            return z ? z.pageIndex + 1 : null;
          })()}
          onPlaceZone={handlePlaceCertZone}
          onSign={handleCertSign}
          onClose={() => {
            certDraftRef.current = null;
            setCertModal(null);
          }}
        />
      )}

      {compare && activeTab && (
        <CompareModal
          baseName={activeTab.name}
          otherName={compare.otherName}
          result={compare.result}
          error={compare.error}
          onClose={() => setCompare(null)}
        />
      )}

      {/* Bottom Status Bar */}
      <footer className="statusbar">
        <div className="status-left">
          <span className="status-pill">
            Outil : <strong>{TOOL_LABELS_FR[activeTool]}</strong>
          </span>
          {activeTab && (
            <span className="status-meta">
              {activeTab.overlays.length} annotation(s) ·{' '}
              {window.fDesktop?.isElectron ? 'F-pdf Desktop Windows' : 'Aperçu Web'}
            </span>
          )}
        </div>

        {activeTab && (
          <div className="status-center">
            <button
              className="status-nav-btn"
              aria-label="Page précédente"
              disabled={activeTab.currentPage <= 1}
              onClick={() =>
                updateActiveTab((t) => ({
                  ...t,
                  currentPage: Math.max(1, t.currentPage - 1),
                }))
              }
            >
              <ChevronLeft size={15} />
            </button>
            <span className="status-page-info">
              Page{' '}
              <input
                type="number"
                className="status-page-input"
                aria-label="Numéro de page"
                min={1}
                max={activeTab.numPages}
                value={activeTab.currentPage}
                onChange={(e) => {
                  const n = Math.max(
                    1,
                    Math.min(activeTab.numPages, Number(e.target.value) || 1)
                  );
                  updateActiveTab((t) => ({ ...t, currentPage: n }));
                }}
              />{' '}
              / {activeTab.numPages}
            </span>
            <button
              className="status-nav-btn"
              aria-label="Page suivante"
              disabled={activeTab.currentPage >= activeTab.numPages}
              onClick={() =>
                updateActiveTab((t) => ({
                  ...t,
                  currentPage: Math.min(t.numPages, t.currentPage + 1),
                }))
              }
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}

        {activeTab && (
          <div className="status-right">
            <input
              type="range"
              aria-label="Niveau de zoom"
              min={0.5}
              max={2.6}
              step={0.05}
              value={activeTab.zoom}
              onChange={(e) =>
                updateActiveTab((t) => ({ ...t, zoom: Number(e.target.value) }))
              }
            />
            <span className="zoom-readout">{Math.round(activeTab.zoom * 100)}%</span>
          </div>
        )}
      </footer>

      <SignatureModal
        isOpen={sigModalOpen}
        onClose={() => setSigModalOpen(false)}
        savedSignatures={savedSignatures}
        onSelectSignature={handleSelectSignature}
        onDeleteSaved={handleDeleteSavedSignature}
      />

      {activeTab && (
        <YousignModal
          key={`${activeTab.id}-${yousignModalKey}`}
          isOpen={yousignModalOpen}
          onClose={() => setYousignModalOpen(false)}
          documentName={activeTab.name}
          numPages={activeTab.numPages}
          currentPage={activeTab.currentPage}
          placedZone={placedYousignZone}
          onRequestVisualPlacement={() => {
            setYousignModalOpen(false);
            setActiveTool('yousign-zone');
            showToast('Cliquez sur la page pour placer la zone de signature Yousign.');
          }}
          getBakedPdfBytes={getBakedPdfBytes}
          onOpenSignedPdf={(name, bytes) => {
            openBytesInTab(name, bytes);
            showToast(`PDF signé ouvert : ${name}`);
          }}
          onApplyDemoYousignStamp={handleApplyDemoYousignStamp}
        />
      )}

      {dragOverFile && (
        <div className="drop-overlay">
          <FolderOpen size={44} />
          <strong>Déposez vos fichiers PDF pour les ouvrir dans F-pdf</strong>
        </div>
      )}

      {toast && (
        <div className="toast-banner" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
