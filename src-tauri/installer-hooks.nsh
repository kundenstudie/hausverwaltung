; HAVEWA-07D G5 - NSIS-Hook: Clean-up des zur Laufzeit erzeugten Install-Root-Residuums.
;
; PROBLEM (G4-MEDIUM, in G5 reproduziert und quantifiziert):
;
;   Die gebündelte Next.js-Standalone-Runtime schreibt zur LAUFZEIT
;   statische Assets in ihr `distDir` (`.next/`). Im Desktop-Betrieb ist das
;   der INSTALL ROOT (`%LOCALAPPDATA%\HaVeWa Desktop`), nicht der Data Root.
;   Ursache: Next.js `isrFlushToDisk` (On-Demand-Route-Generierung) schreibt
;   die Client-Chunks bzw. das Build-Manifest des generierten Builds in
;   `.next/static/<BUILD_ID>/`.
;
;   Diese Dateien tragen einen ANDEREN BUILD_ID als die gebündelten und
;   stehen deshalb NICHT in der Datei-Tabelle des NSIS-Installers. Der
;   Uninstaller kann sie nicht loeschen -> Rueckstand:
;
;     %LOCALAPPDATA%\HaVeWa Desktop\runtime\app\.next\static\chunks\*.js|css
;     %LOCALAPPDATA%\HaVeWa Desktop\runtime\app\.next\static\<BUILD_ID>\*_manifest.js
;
;   Zusaetzlich bleiben leere Verzeichnisgerueste zurueck:
;     runtime\app\node_modules\.cache\prisma\...
;     runtime\app\scripts\.runtime\prisma-cli\node_modules\.cache\jiti
;
; LÖSUNG (minimal, sicher, reproduzierbar):
;
;   Der Uninstaller entfernt VOR dem regulaeren Datei-Loeschen (Hook
;   PREUNINSTALL) per `RMDir /r /s` den kompletten `runtime\app\.next\static`
;   -Baum sowie die beiden Cache-Gerueste.
;
;   Warum der ganze `static`-Baum und nicht nur die Fremd-Dateien:
;   Der NSIS-Uninstaller loescht ohnehin ALLE Dateien, die er kennt
;   (inkl. der gebuendelten `static`-Dateien). Das `RMDir /r /s` ersetzt
;   diese Einzel-Deletes durch einen rekursiven Baum-Loesch — identisches
;   Ergebnis, aber ohne die Rest-Dateien aus der Laufzeit-Generierung.
;
;   WICHTIG: Der Hook loescht NIE den Data Root (`%LOCALAPPDATA%\HaVeWa`) —
;   der liegt ausserhalb von `$INSTDIR` und wird hier nicht angefasst.
;   Ebenso werden keine fremden Prozesse oder Dateien beeinflusst.
;   `RMDir /r` loescht rekursiv; `/REBOOTOK` markiert gesperrte Dateien fuer
;   den naechsten Neustart (statt den Uninstall zu blockieren).

!macro NSIS_HOOK_PREUNINSTALL
  ; 1) Zur Laufzeit erzeugte statische Next-Assets + ISR-Flush entfernen.
  RMDir /r /REBOOTOK "$INSTDIR\runtime\app\.next\static"

  ; 2) Leere Cache-Gerueste (Prisma-Query-Engine-Cache, jiti-Cache).
  RMDir /r /REBOOTOK "$INSTDIR\runtime\app\node_modules\.cache"
  RMDir /r /REBOOTOK "$INSTDIR\runtime\app\scripts\.runtime\prisma-cli\node_modules\.cache"
!macroend
