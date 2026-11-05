// HAVEWA-07C — Tauri v2 Build-Script.
// HAVEWA-07D G3 — Resources aktiviert.
//
// tauri_build erzeugt den plattform-/schema-spezifischen Glue-Code
// (Capabilities-Bindung, Windows-Ressourcen, Identifier-Patch) und
// validiert die Konfiguration inkl. `bundle.resources`.
//
// Der Bundle-Aufruf (NSIS-Installer) erfolgt ueber `tauri build`
// (Tauri-CLI) — nicht ueber cargo build. In 07D G3 bauen wir die
// x64-EXE; der finale NSIS-Installer ist G4.
//
// WICHTIG: `bundle.resources` ist in tauri.conf.json als Map konfiguriert:
//   "resources": { "resources/runtime/": "runtime/" }
// -> die gebündelte Runtime landet im installierten Produkt unter
//    <install-root>\runtime\ (Windows: resource_dir() == EXE-Verzeichnis).

fn main() {
    tauri_build::build();
}
