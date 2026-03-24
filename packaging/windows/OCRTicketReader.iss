#define AppName "OCR Ticket Reader"
#define AppVersion "0.1.0"

#ifndef SourceBundle
  #error SourceBundle must be provided via /DSourceBundle=...
#endif

#ifndef ReleaseRoot
  #define ReleaseRoot SourceBundle
#endif

[Setup]
AppId={{4D341625-EC21-44B5-9D68-B91A6FB5FA16}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\OCRTicketReader
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#ReleaseRoot}\installer
OutputBaseFilename=ocr-ticket-reader-setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "{#SourceBundle}\ocr-ticket-reader.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceBundle}\ocr-backend\*"; DestDir: "{app}\ocr-backend"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\OCR Ticket Reader"; Filename: "{app}\ocr-ticket-reader.exe"
Name: "{autodesktop}\OCR Ticket Reader"; Filename: "{app}\ocr-ticket-reader.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\ocr-ticket-reader.exe"; Description: "Launch OCR Ticket Reader"; Flags: nowait postinstall skipifsilent
