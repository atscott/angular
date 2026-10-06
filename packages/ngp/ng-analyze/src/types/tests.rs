use super::analysis::ImportPath;
use std::path::{Path, PathBuf};

#[test]
fn test_import_path_to_specifier() {
    let import_path = ImportPath::ResolvedFile(PathBuf::from("/foo/bar/pipes/upcase.pipe.ts"));
    let from_file = Path::new("/foo/bar/components/parent.component.ts");
    let result = import_path.to_specifier(from_file);
    assert_eq!(result, "../pipes/upcase.pipe");

    let import_path = ImportPath::ResolvedFile(PathBuf::from("/local.module.ts"));
    let from_file = Path::new("/app.component.ts");
    let result = import_path.to_specifier(from_file);
    assert_eq!(result, "./local.module");
}
