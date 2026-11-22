# Audit avant vente — F-pdf (éditeur PDF Windows)

Date : 21/11/2026 · Auditeur : Claude Code · Version : 1.0.0 (commit `44ec929` + corrections non commitées)

## Verdict

**Pas encore prêt à la vente.** Le code est sérieux : bonne sécurité Electron, clé Yousign chiffrée, aucune faille connue dans les bibliothèques livrées.
Il manque surtout ce qui entoure un produit payant : signature du code, licence, mises à jour, tests. Il reste aussi quelques limites face à Foxit (voir plus bas).

## Ce qui a été vérifié

| Contrôle | Résultat |
|---|---|
| Lint (`oxlint`) | 0 erreur |
| Compilation TypeScript + build Vite | OK |
| Installateur Windows (NSIS + portable) | OK, installé et lancé sur le PC |
| `npm audit` (bibliothèques livrées) | 0 faille |
| `npm audit` (outils de build) | 6 moyennes (`minimatch`), pas dans l'app livrée |
| Sécurité Electron | `contextIsolation`, `sandbox`, pas de `nodeIntegration`, IPC filtré, navigation bloquée, CSP stricte : OK |
| Clé API Yousign | Chiffrée par Windows (DPAPI), jamais envoyée à l'interface : OK |
| Moteur PDF (tests réels dans un navigateur) | 2 bugs trouvés et corrigés (voir ci-dessous) |
| OCR dans l'app empaquetée | OK, hors ligne, français reconnu |
| Interface (ruban, onglets, Yousign) | Propre, proche de Foxit |

## Corrigé pendant l'audit (prouvé par test)

1. **Caviardage factice (grave, risque juridique).** Le rectangle noir cachait le texte, mais le texte restait copiable et extractible.
   Correction : à l'enregistrement, chaque page caviardée devient une image. Le texte caché est réellement supprimé.
   Test : page entièrement caviardée → texte extrait vide.
2. **Échec d'enregistrement.** Si on rouvrait un PDF fait avec F-pdf et qu'on ajoutait un champ de formulaire, l'enregistrement plantait (« A field already exists »). Correction : noms de champs uniques.
3. **Purge des métadonnées incomplète.** Le bloc XMP (auteur, logiciel, historique) restait dans le fichier. Il est maintenant supprimé.
4. **Yousign :**
   - le signataire par défaut était pré-rempli avec une fausse adresse (`camille.martin@exemple.fr`) : champs maintenant vides ;
   - confirmation obligatoire avant un envoi réel en production (envoi facturé) ;
   - en mode Démo, le PDF s'appelait « Signé Yousign » et un faux lien `yousign.app` était créé. Maintenant c'est « DÉMO - NON SIGNÉ », sans lien ;
   - messages d'erreur Yousign détaillés (sans la clé) ;
   - contrôle des données reçues de l'interface avant tout appel réseau.
5. **OCR 100 % hors ligne.** Les modèles français et anglais sont intégrés (3,5 Mo). La CSP n'autorise plus aucun site externe.
6. **Électron : permissions refusées.** Caméra, micro, position et notifications sont refusés. Seule la copie de texte reste permise.
7. **Perte de travail à la fermeture.** Fermer la fenêtre avec un document modifié ne prévenait pas. Une boîte « Quitter sans enregistrer / Annuler » s'affiche maintenant (testé).

## Reste à faire — bloquant pour vendre

1. **Signer le code** avec un certificat de signature de code (payant, coût à vérifier). Sans lui, Windows SmartScreen affiche « Éditeur inconnu » : beaucoup de clients s'arrêtent là.
2. **Licence et documents légaux** : contrat de licence (EULA) dans l'installateur, CGV, mentions légales, politique de confidentialité.
   Point RGPD : les noms, e-mails et téléphones des signataires sont envoyés à Yousign.
3. **Yousign** : chaque client doit avoir son propre compte API Yousign. À expliquer clairement. Vérifier aussi les conditions de Yousign pour un logiciel revendu.
4. **Système de licence ou d'activation** (clé produit), sinon l'app est copiable librement.
5. **Mises à jour automatiques** (`electron-updater`) : aujourd'hui, aucun moyen de corriger un bug chez les clients.
6. **Tests automatisés** : aucun test. Au minimum : le moteur PDF (caviardage, formulaires, rotation, fusion) et un test de bout en bout.
7. **Nom « F-pdf »** : difficile à trouver et à déposer. Vérifier l'INPI avant de vendre. Ajouter l'auteur et le copyright dans `package.json`.

## Écarts avec Foxit — comblés le 21/11/2026 (testés)

| Écart | Correction | Preuve de test |
|---|---|---|
| PDF protégés par mot de passe | Demande du mot de passe à l'ouverture (3 essais). La protection est conservée à l'enregistrement. Nouveau bouton **Protéger** : chiffrement AES-256, mot de passe propriétaire, droits impression / copie / modification. | Mauvais mot de passe refusé ; bon mot de passe → document ouvert ; PDF chiffré illisible sans mot de passe. |
| Caractères non latins | Police DejaVu Sans intégrée dès que le texte sort de l'alphabet latin (grec, cyrillique, symboles). Helvetica sinon, pour garder des fichiers légers. | En-tête « Ελληνικά — Кириллица » retrouvé dans le PDF. |
| Modifier le texte d'origine | Outil **Modifier texte** (onglet Éditer) : la ligne est **réécrite directement dans le contenu de la page**, avec la police, la taille, la couleur et l'espacement du document. Plus aucun cache blanc. Si un caractère manque dans la police intégrée, seul ce caractère passe dans une police de même style (avec ou sans empattement, gras, italique), comme dans Foxit. Polices standard (Helvetica, Times, Arial…) également gérées. | PDF réel sur fond bleu : 0 pixel blanc ; police d'origine conservée ; chiffres absents complétés ; autres lignes à la même position au point près. |
| Annotations aplaties | Surlignage, formes, stylo, flèches, notes, textes et tampons deviennent de **vraies annotations PDF**, modifiables dans Acrobat ou Foxit. F-pdf les relit et les rend modifiables à la réouverture. Case **Aplatir annotations** pour l'ancien comportement. | 6 annotations reconnues par PDF.js (Highlight, Square, FreeText, Line, Stamp) ; relecture des 6 en éléments modifiables. |
| Pages pivotées | Images, signatures, textes, notes et tampons placés et orientés correctement à 90°, 180° et 270°. | Signature placée en haut à gauche d'une page pivotée de 90° : pixels rouges au bon endroit. |
| Signatures en clair | Signatures enregistrées chiffrées par Windows (DPAPI). Les anciennes sont migrées puis effacées du stockage local. | Écriture puis relecture chiffrées OK ; clé inconnue refusée. |
| Export Word | **Exporter Word** (onglet Convertir & OCR) : paragraphes reconstitués, titres, gras, italique, tailles, couleurs, polices (Arial, Times, Calibri…), alignements, retraits, **tableaux**, **images**, format et marges de page du PDF. | Rapport de test : ouvert dans Word et comparé au PDF, rendu quasi identique (tableau 4×3, image, titres en couleur). |
| Comparaison | **Comparer** (onglet Organiser) : différences de texte page par page, ajouts en vert et suppressions en rose. | Ligne modifiée détectée sur la bonne page. |
| Signature par certificat numérique | **Signature certificat** (onglet Formulaire & Signer) : certificat .pfx / .p12, ou **création d'un ID numérique personnel** (RSA 2048, 3 ans). Signature visible placée sur la page (nom, date, motif, lieu) ou invisible. Format PKCS#7 détaché, lu par Acrobat et Foxit. La clé privée reste dans le processus principal d'Electron. Avertissement à l'ouverture d'un PDF déjà signé, et avant de l'enregistrer de nouveau. | Signature vérifiée par OpenSSL (« Verification successful ») ; document modifié d'un octet → « verification failure » ; champ de signature reconnu (Widget/Sig). |
| OCR du document entier | **OCR document entier** : toutes les pages. Le texte reconnu est placé ligne par ligne, à sa position : le PDF devient recherchable et sélectionnable. | Code testé ; à vérifier sur un vrai scan. |

## Reste à faire — fonctionnel (limites connues)

- **Écritures complexes** : le chinois, le japonais et le coréen ne sont pas couverts par la police. L'arabe et l'hébreu sont écrits sans mise en forme de droite à gauche.
- **Modifier texte** : ligne par ligne ; ajouter des lignes ne fait pas glisser le paragraphe suivant (pas de refonte de paragraphe). Polices Type 3 ou encodages rares : repli sur un cache blanc + nouvelle police (rare).
- **Export Word** : les mises en page complexes (colonnes multiples, zones de texte flottantes, tableaux sans alignement net) sont approchées. **Excel** : absent.
- **Comparaison** : texte seulement (pas les images ni la mise en forme).
- **Signature par certificat** : horodatage par un serveur (TSA), validation longue durée (PAdES LTV), cartes à puce et magasin de certificats Windows : absents. Un ID personnel prouve l'intégrité, pas l'identité légale (utiliser un certificat d'autorité ou Yousign). Formulaires XFA, PDF/A : absents.
## Reste à faire — technique

- `src/App.tsx` fait environ 1 900 lignes : à découper en modules.
- `npm run electron:dev` ne marche pas, car le binaire Electron n'est pas téléchargé (script d'installation bloqué par npm). Solution : `node node_modules/electron/install.js`.
- Accessibilité (clavier, lecteur d'écran) : pas auditée en détail.

## Fichiers modifiés

`electron/main.cjs`, `index.html`, `src/App.tsx`, `src/utils/pdfEngine.ts`, `src/utils/yousign.ts`, `src/components/YousignModal.tsx`, `package.json`, `package-lock.json`, nouveau dossier `public/tesseract/lang/`.
Mise à jour du 21/11/2026 : application renommée **F-pdf** (appId `com.rapideit.fpdf`, auteur Rapide iT) et interface passée à la charte Rapide iT (bleu #1746D1, rose en accent, bleu nuit, polices Manrope et Inter auto-hébergées, nouvelle icône).
