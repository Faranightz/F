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

## Reste à faire — fonctionnel (écart avec Foxit)

- **PDF protégés par mot de passe** : non gérés (ouverture impossible).
- **Caractères non latins** (arabe, chinois, etc.) supprimés à l'export, à cause de la police Helvetica. Il faut intégrer une police Unicode (`@pdf-lib/fontkit`).
- **Modifier le texte d'origine** du PDF : impossible. F-pdf ajoute seulement des blocs de texte par-dessus. Foxit le fait.
- **Annotations « aplaties »** : elles sont dessinées dans la page, pas enregistrées comme de vraies annotations PDF. On ne peut donc plus les modifier dans Acrobat ou Foxit.
- **Pages pivotées** : placement des images et signatures approximatif.
- **Signatures manuscrites enregistrées en clair** dans le stockage local. Il faudrait les chiffrer (DPAPI), comme la clé Yousign.
- Conversion vers Word / Excel, comparaison de documents, OCR de tout le document en une fois : absents.

## Reste à faire — technique

- `src/App.tsx` fait environ 1 900 lignes : à découper en modules.
- `npm run electron:dev` ne marche pas, car le binaire Electron n'est pas téléchargé (script d'installation bloqué par npm). Solution : `node node_modules/electron/install.js`.
- Accessibilité (clavier, lecteur d'écran) : pas auditée en détail.

## Fichiers modifiés

`electron/main.cjs`, `index.html`, `src/App.tsx`, `src/utils/pdfEngine.ts`, `src/utils/yousign.ts`, `src/components/YousignModal.tsx`, `package.json`, `package-lock.json`, nouveau dossier `public/tesseract/lang/`.
Mise à jour du 21/11/2026 : application renommée **F-pdf** (appId `com.rapideit.fpdf`, auteur Rapide iT) et interface passée à la charte Rapide iT (bleu #1746D1, rose en accent, bleu nuit, polices Manrope et Inter auto-hébergées, nouvelle icône).
