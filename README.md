# F-pdf — Éditeur PDF Windows

**F-pdf** est un éditeur PDF desktop pour Windows (Electron + React + TypeScript + PDF.js + pdf-lib + Tesseract.js) avec interface Ruban multi-onglets, annotations, organisation de pages, OCR et intégration **Yousign eIDAS (API v3)**.

## Fonctionnalités
- **Interface Ruban multi-onglets** (*Accueil*, *Commentaire*, *Éditer*, *Organiser*, *Formulaire & Signer*, *Convertir & OCR*) + mode clair / sombre conforme WCAG AA.
- **Annotations & commentaires** : surlignage (couleur libre), dessin libre (stylo), rectangle, ellipse, flèche, notes adhésives, tampons (`APPROUVÉ`, `CONFIDENTIEL`, `BROUILLON`, `URGENT`, `SIGNÉ`, `RÉVISÉ`), poignées de déplacement et redimensionnement, Annuler / Rétablir (`Ctrl+Z` / `Ctrl+Y`).
- **Édition PDF** : ajout/édition de blocs de texte, insertion d'images, filigrane centré, en-têtes & pieds de page (`{page} / {total}`).
- **Organisation des pages** : vue grille, réorganisation par glisser-déposer, rotation (avec respect des coordonnées d'annotations), duplication, suppression, insertion de page vierge, fusion de PDF et extraction/division avec annotations intégrées.
- **Formulaires & Signatures** : champs texte, cases à cocher, signature manuscrite (dessin, calligraphie locale hors-ligne ou image importée).
- **Yousign eIDAS (API v3)** : création de demandes multi-signataires (SES / AES + OTP SMS / QES + OTP SMS), stockage chiffré de la clé API via Windows DPAPI (`safeStorage`) et proxy IPC dans le processus principal Electron (sans CORS), plus **Mode Démo local** pour tester sans clé API.
- **OCR & Export** : reconnaissance optique de caractères (Français / Anglais) via Tesseract.js, export PDF natif (encodage WinAnsi sécurisé), export PNG/JPEG incluant toutes les annotations, export texte (`.txt`) et impression PDF propre.

## Compiler l'installateur Windows (`.exe`)

Sur Windows (Node.js 20+) :

```bash
npm install
npm run build:win
```

Les exécutables Windows (installateur NSIS `x64` + version portable `x64`) sont générés dans `release/`.

Pour lancer **F-pdf** en développement desktop :

```bash
npm run electron:dev
```
