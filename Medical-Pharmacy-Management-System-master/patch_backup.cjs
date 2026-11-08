const fs = require('fs');
let content = fs.readFileSync('src/components/SettingsBackupScreen.tsx', 'utf8');

// Add successMsg state
content = content.replace(
  "const [importFileName, setImportFileName] = useState('');",
  "const [importFileName, setImportFileName] = useState('');\n  const [successMsg, setSuccessMsg] = useState('');"
);

// Replace alert with setSuccessMsg
content = content.replace(
  /alert\(res\.message \|\| 'Database restored successfully from encrypted backup!'\);\n\s*setImportFilePayload\(null\);\n\s*setImportPassword\(''\);\n\s*setImportFileName\(''\);\n\s*window\.location\.reload\(\);/g,
  `setSuccessMsg(res.message || 'Database restored successfully from encrypted backup! Reloading...');
      setImportFilePayload(null);
      setImportPassword('');
      setImportFileName('');
      setTimeout(() => window.location.reload(), 2000);`
);

// Add successMsg div above the file input
content = content.replace(
  /\{importError && \(\n\s*<div className="p-2\.5 bg-rose-950\/80 border border-rose-800 text-rose-300 rounded-xl flex items-center gap-1\.5 text-\[11px\]">\n\s*<AlertTriangle className="w-3\.5 h-3\.5 text-rose-400 shrink-0" \/>\n\s*<span>\{importError\}<\/span>\n\s*<\/div>\n\s*\)\}/g,
  `{importError && (
                  <div className="p-2.5 bg-rose-950/80 border border-rose-800 text-rose-300 rounded-xl flex items-center gap-1.5 text-[11px]">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                    <span>{importError}</span>
                  </div>
                )}
                {successMsg && (
                  <div className="p-2.5 bg-emerald-950/80 border border-emerald-800 text-emerald-300 rounded-xl flex items-center gap-1.5 text-[11px]">
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>{successMsg}</span>
                  </div>
                )}`
);

fs.writeFileSync('src/components/SettingsBackupScreen.tsx', content);
