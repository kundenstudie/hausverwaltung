// HAVEWA-07C — Tauri v2 Build-Script.
// tauri_build erzeugt den plattform-/schema-spezifischen Glue-Code
// (Capabilities-Bindung, Windows-Ressourcen, Identifier-Patch).
//
// Hinweis: Es macht KEINEN Installer-Bundle-Aufruf (bundle.active=false in
// tauri.conf.json). Bundling/Installer sind 07D.

fn main() {
    tauri_build::build();
}