use super::*;
use crate::fs::OverlayFileSystem;
use crate::types::{AnalysisResult, AnalyzerOptions, FileInvalidation, FileUpdate, FileUpdateType};
use crate::utils::create_resolver_with_fs;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[test]
fn test_update_file_content() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            @Component({
                selector: 'app-root',
                template: '<h1>Hello</h1>'
            })
            export class AppComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();

    let content = analyzer.get_file_content("/project/app.ts".to_string());
    assert!(content.is_ok());
    let content_str = content.unwrap();
    assert!(content_str.contains("Hello"));
    assert!(!content_str.contains("Hello Updated"));

    let update = FileUpdate {
        file_path: "/project/app.ts".to_string(),
        content: r#"
            import {Component} from '@angular/core';
            @Component({
                selector: 'app-root',
                template: '<h1>Hello Updated</h1>'
            })
            export class AppComponent {}
        "#
        .to_string(),
    };

    analyzer.update_file_content(vec![update]).unwrap();

    let result = analyzer.get_metadata_for_file("/project/app.ts".to_string());
    assert!(result.is_some());
    let analysis = result.unwrap();
    assert_eq!(analysis.file_path, "/project/app.ts");

    let content = analyzer.get_file_content("/project/app.ts".to_string());
    assert!(content.is_ok());
    assert!(content.unwrap().contains("Hello Updated"));
}

#[derive(Clone)]
struct DelayedFileSystem {
    fs: OverlayFileSystem,
    delayed_path: PathBuf,
    delay_ms: u64,
}

impl DelayedFileSystem {
    fn new(fs: OverlayFileSystem, delayed_path: &str, delay_ms: u64) -> Self {
        Self {
            fs,
            delayed_path: PathBuf::from(delayed_path),
            delay_ms,
        }
    }
}

impl oxc_resolver::FileSystem for DelayedFileSystem {
    fn new() -> Self {
        panic!("Not supported");
    }

    fn read(&self, path: &Path) -> std::io::Result<Vec<u8>> {
        if path == self.delayed_path {
            std::thread::sleep(std::time::Duration::from_millis(self.delay_ms));
        }
        self.fs.read(path)
    }

    fn read_to_string(&self, path: &Path) -> std::io::Result<String> {
        if path == self.delayed_path {
            std::thread::sleep(std::time::Duration::from_millis(self.delay_ms));
        }
        self.fs.read_to_string(path)
    }

    fn metadata(&self, path: &Path) -> std::io::Result<oxc_resolver::FileMetadata> {
        self.fs.metadata(path)
    }

    fn symlink_metadata(&self, path: &Path) -> std::io::Result<oxc_resolver::FileMetadata> {
        self.fs.symlink_metadata(path)
    }

    fn read_link(&self, path: &Path) -> std::result::Result<PathBuf, oxc_resolver::ResolveError> {
        self.fs.read_link(path)
    }

    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
        self.fs.canonicalize(path)
    }
}

impl crate::ResourceResolverFs for DelayedFileSystem {
    fn root_dirs(&self) -> Vec<PathBuf> {
        Vec::new()
    }
}

fn run_async_compiler_test<Fs: crate::ResourceResolverFs + Clone + 'static>(
    entrypoints: Vec<PathBuf>,
    fs: Fs,
    resolver: Arc<oxc_resolver::ResolverGeneric<Fs>>,
    final_sender: std::sync::mpsc::Sender<AnalysisResult>,
) {
    let pool = futures::executor::ThreadPool::builder()
        .pool_size(2)
        .create()
        .unwrap();

    let resource_registry = Arc::new(crate::resource_registry::ResourceRegistry::default());
    let engine = crate::query::QueryEngine::new_default(
        fs.clone(),
        resolver.clone(),
        resource_registry.clone(),
        Arc::new(std::sync::RwLock::new(entrypoints.clone())),
    );

    let mut queue = std::collections::VecDeque::from(entrypoints.clone());
    let mut seen_files: std::collections::HashSet<PathBuf> =
        std::collections::HashSet::from_iter(entrypoints.clone());
    let (batch_sender, batch_receiver) = std::sync::mpsc::channel();

    while !queue.is_empty() {
        let mut batch_count = 0;

        while let Some(file_path) = queue.pop_front() {
            let engine = engine.clone();
            let tx = batch_sender.clone();

            pool.spawn_ok(async move {
                let resolved = engine.analyze_optimized(file_path.clone()).await;
                let _ = tx.send((file_path, resolved));
            });
            batch_count += 1;
        }

        for _ in 0..batch_count {
            let (_file_path, resolved) = batch_receiver.recv().unwrap();

            let parse_res = engine.parse_file_by_id_blocking(resolved.file_id);
            let source_text = parse_res.lock().unwrap().borrow_owner().source_text.clone();

            let path_lookup = |id| engine.lookup_path(id);
            let declaring_exports = engine.declaring_export_names_blocking(&resolved);
            let cx = crate::analyzer::WireContext {
                mode: crate::analyzer::WireMode::Semantic,
                source_text: &source_text,
                converter: &resolved.converter,
                reference_strategy: &*engine.reference_strategy,
                path_lookup: Some(&path_lookup),
                declaring_exports: &declaring_exports,
            };

            let _ = final_sender.send(
                resolved
                    .to_wire(&cx)
                    .expect("semantic wire projection invariant"),
            );

            // Walk the file's resolved direct imports (graph edges) to discover the next files.
            for dep_path in &resolved.resolved_dependencies {
                if seen_files.insert(dep_path.clone()) {
                    queue.push_back(dep_path.clone());
                }
            }
        }
    }
}

#[test]
fn test_async_streaming_behavior() {
    let fs = OverlayFileSystem::new_with_overlay();
    fs.upsert_file(
        PathBuf::from("/project/tsconfig.json"),
        r#"{"files": ["a.ts", "b.ts"]}"#.to_string(),
    );
    fs.upsert_file(
        PathBuf::from("/project/a.ts"),
        "export class A {}".to_string(),
    );
    fs.upsert_file(
        PathBuf::from("/project/b.ts"),
        "export class B {}".to_string(),
    );

    // Delay b.ts's read so a.ts (trivial) must stream first. The delay is generous because the
    // self-driving queries run on the *shared global* thread pool — under parallel `cargo test`
    // load a.ts can be briefly starved, so the margin must clear that contention, not just b's read.
    let delayed_fs = DelayedFileSystem::new(fs, "/project/b.ts", 250);
    let resolver = Arc::new(create_resolver_with_fs(
        Path::new("/project/tsconfig.json"),
        delayed_fs.clone(),
        false,
        None,
    ));

    let (final_sender, receiver) = std::sync::mpsc::channel();

    run_async_compiler_test(
        vec![
            PathBuf::from("/project/a.ts"),
            PathBuf::from("/project/b.ts"),
        ],
        delayed_fs,
        resolver,
        final_sender,
    );

    let start = std::time::Instant::now();

    // We expect to receive A first because B is delayed
    let first = receiver.recv().unwrap();
    let elapsed = start.elapsed();

    assert_eq!(first.file_path, "/project/a.ts");
    // a.ts streamed without waiting for b.ts's 250ms-delayed read (streaming, not batch-at-end).
    assert!(
        elapsed < std::time::Duration::from_millis(250),
        "Expected a.ts to stream before b.ts's delay elapsed, but took {:?}",
        elapsed
    );

    let second = receiver.recv().unwrap();
    assert_eq!(second.file_path, "/project/b.ts");
}

#[test]
fn test_invalidate_files_html_returns_affected_ts() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            @Component({
                templateUrl: './app.component.html'
            })
            export class AppComponent {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.component.html".to_string(),
        "<h1>Hello</h1>".to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze().unwrap();

    // Consume the result
    let result = futures::executor::block_on(iterator.next()).unwrap();
    assert!(result.is_some());

    // Invalidate the HTML file
    let affected = analyzer
        .invalidate_files(vec![FileInvalidation {
            file_path: "/project/app.component.html".to_string(),
            update_type: FileUpdateType::Changed,
        }])
        .unwrap();

    // Check that the TS file is returned as affected
    assert_eq!(affected.len(), 1);
    assert_eq!(affected[0], "/project/app.ts");

    // The TS file was NOT re-analyzed because it was just an edit (Changed),
    // but we still have the analysis from the original cache (updated in place).
    let ts_metadata = analyzer.get_metadata_for_file("/project/app.ts".to_string());
    assert!(ts_metadata.is_some());
}

#[test]
fn test_invalidate_files_html_template_deletion_edge_case() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            @Component({
                templateUrl: './app.component.html'
            })
            export class AppComponent {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.component.html".to_string(),
        "<h1>Hello</h1>".to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze().unwrap();

    // Consume the result
    let result = futures::executor::block_on(iterator.next()).unwrap();
    assert!(result.is_some());

    let affected = analyzer
        .invalidate_files(vec![FileInvalidation {
            file_path: "/project/app.component.html".to_string(),
            update_type: FileUpdateType::Deleted,
        }])
        .unwrap();

    assert_eq!(affected.len(), 1);
    assert_eq!(affected[0], "/project/app.ts");

    // Verify that the TS file WAS re-analyzed (even though the template was deleted, the TS file exists).
    let ts_metadata = analyzer.get_metadata_for_file("/project/app.ts".to_string());
    assert!(ts_metadata.is_some());

    // Verify that the association is still in the registry (NGTSC behavior: references are preserved).
    let components_after =
        analyzer.get_ts_file_for_template("/project/app.component.html".to_string());
    assert!(components_after.is_some());
}

#[test]
fn test_invalidate_files_html_multiple_components() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts", "admin.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            @Component({
                selector: 'app-root',
                templateUrl: './shared.component.html'
            })
            export class AppComponent {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/admin.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            @Component({
                selector: 'app-admin',
                templateUrl: './shared.component.html'
            })
            export class AdminComponent {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/shared.component.html".to_string(),
        "<h1>Hello Shared</h1>".to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze().unwrap();

    // Consume results
    let mut count = 0;
    while futures::executor::block_on(iterator.next())
        .unwrap()
        .is_some()
    {
        count += 1;
    }
    assert_eq!(count, 2);

    // Invalidate the shared HTML file
    let affected = analyzer
        .invalidate_files(vec![FileInvalidation {
            file_path: "/project/shared.component.html".to_string(),
            update_type: FileUpdateType::Changed,
        }])
        .unwrap();

    // Check that BOTH TS files are returned as affected
    assert_eq!(affected.len(), 2);
    assert!(affected.contains(&"/project/app.ts".to_string()));
    assert!(affected.contains(&"/project/admin.ts".to_string()));
}

#[test]
fn test_invalidate_files_unregistered_file() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            @Component({
                selector: 'app-root',
                template: '<h1>Hello</h1>'
            })
            export class AppComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze().unwrap();

    // Consume the result
    let result = futures::executor::block_on(iterator.next()).unwrap();
    assert!(result.is_some());

    // Invalidate a file that is not in the registry
    let affected = analyzer
        .invalidate_files(vec![FileInvalidation {
            file_path: "/project/random.html".to_string(),
            update_type: FileUpdateType::Changed,
        }])
        .unwrap();

    // Check that no files are affected
    assert_eq!(affected.len(), 0);
}

#[test]
fn test_invalidate_files_multiple_components_in_one_file() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            
            @Component({
                selector: 'app-root',
                templateUrl: './app.component.html'
            })
            export class AppComponent {}

            @Component({
                selector: 'app-admin',
                templateUrl: './admin.component.html'
            })
            export class AdminComponent {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.component.html".to_string(),
        "<h1>Hello App</h1>".to_string(),
    );
    virtual_files.insert(
        "/project/admin.component.html".to_string(),
        "<h1>Hello Admin</h1>".to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze().unwrap();

    // Consume results
    let result = futures::executor::block_on(iterator.next()).unwrap();
    assert!(result.is_some());

    // Verify both are registered
    let app_comps = analyzer.get_ts_file_for_template("/project/app.component.html".to_string());
    assert!(app_comps.is_some());
    let app_v = app_comps.unwrap();
    assert_eq!(app_v.len(), 1);
    assert_eq!(app_v[0].ts_file_path, "/project/app.ts");

    let admin_comps =
        analyzer.get_ts_file_for_template("/project/admin.component.html".to_string());
    assert!(admin_comps.is_some());
    let admin_v = admin_comps.unwrap();
    assert_eq!(admin_v.len(), 1);
    assert_eq!(admin_v[0].ts_file_path, "/project/app.ts");

    // Invalidate the TS file
    let affected = analyzer
        .invalidate_files(vec![FileInvalidation {
            file_path: "/project/app.ts".to_string(),
            update_type: FileUpdateType::Deleted,
        }])
        .unwrap();

    // Check that the TS file is returned as affected
    assert_eq!(affected.len(), 1);
    assert_eq!(affected[0], "/project/app.ts");

    // Verify both templates are unregistered
    let app_comps_after =
        analyzer.get_ts_file_for_template("/project/app.component.html".to_string());
    assert!(app_comps_after.is_none());

    let admin_comps_after =
        analyzer.get_ts_file_for_template("/project/admin.component.html".to_string());
    assert!(admin_comps_after.is_none());
}

#[test]
fn test_invalidate_files_html_partial_file_invalidation() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            
            @Component({
                templateUrl: './app.component.html'
            })
            export class AppComponent {}

            @Component({
                templateUrl: './admin.component.html'
            })
            export class AdminComponent {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.component.html".to_string(),
        "<h1>Hello App</h1>".to_string(),
    );
    virtual_files.insert(
        "/project/admin.component.html".to_string(),
        "<h1>Hello Admin</h1>".to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze().unwrap();

    // Consume results
    let result = futures::executor::block_on(iterator.next()).unwrap();
    assert!(result.is_some());

    // Invalidate ONLY the app HTML file
    let affected = analyzer
        .invalidate_files(vec![FileInvalidation {
            file_path: "/project/app.component.html".to_string(),
            update_type: FileUpdateType::Deleted,
        }])
        .unwrap();

    // Check that the TS file is returned as affected
    assert_eq!(affected.len(), 1);
    assert_eq!(affected[0], "/project/app.ts");

    // Verify that the TS file WAS re-analyzed
    let ts_metadata = analyzer.get_metadata_for_file("/project/app.ts".to_string());
    assert!(ts_metadata.is_some());

    // Verify that BOTH templates are still registered in the registry (references preserved)
    let app_comps = analyzer.get_ts_file_for_template("/project/app.component.html".to_string());
    assert!(app_comps.is_some());

    let admin_comps =
        analyzer.get_ts_file_for_template("/project/admin.component.html".to_string());
    assert!(admin_comps.is_some());
}

#[test]
fn test_resource_registry_missing_template_file() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            @Component({
                selector: 'app-root',
                templateUrl: './missing.component.html'
            })
            export class AppComponent {}
        "#
        .to_string(),
    );
    // Note: We do NOT create /project/missing.component.html

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze().unwrap();

    // Consume the result
    let result = futures::executor::block_on(iterator.next()).unwrap();
    assert!(result.is_some());
    assert_eq!(result.unwrap().files[0].file_path, "/project/app.ts");

    // Verify that the association is still in the registry even though the file was missing
    let components =
        analyzer.get_ts_file_for_template("/project/missing.component.html".to_string());
    assert!(components.is_some());
    let comps = components.unwrap();
    assert_eq!(comps.len(), 1);
    assert_eq!(comps[0].ts_file_path, "/project/app.ts");
}

#[test]
fn test_analysis_cancellation() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["a.ts"]}"#.to_string(),
    );
    virtual_files.insert("/project/a.ts".to_string(), "export class A {}".to_string());

    let fs = OverlayFileSystem::new_with_overlay();
    for (path, content) in &virtual_files {
        fs.upsert_file(PathBuf::from(path), content.clone());
    }

    // Delay a.ts by 100ms
    fs.set_delay(PathBuf::from("/project/a.ts"), 100);

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: None,
        ..Default::default()
    };

    let analyzer = Analyzer::new_core_with_fs(options, fs).unwrap();

    // Start streaming analysis
    let iterator = analyzer.analyze().unwrap();

    // Trigger update to cancel while a.ts is delayed
    let update = FileUpdate {
        file_path: "/project/a.ts".to_string(),
        content: "export class A { updated = true; }".to_string(),
    };

    std::thread::sleep(std::time::Duration::from_millis(50));
    analyzer.update_file_content(vec![update]).unwrap();

    // The next() call should return None because a.ts's analysis was canceled
    let result = futures::executor::block_on(iterator.next()).unwrap();
    assert!(result.is_none());
}

#[test]
fn test_dynamic_optimization_switching_no_panic() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            @Component({
                selector: 'app-root',
                template: '<h1>Dynamic Switching</h1>'
            })
            export class AppComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false), // Explicitly initialized with unoptimized!
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();

    // Perform unoptimized analysis first
    let iter1 = analyzer.analyze().unwrap();
    let res1 = futures::executor::block_on(iter1.next()).unwrap();
    assert!(res1.is_some());
    assert_eq!(res1.unwrap().files[0].file_path, "/project/app.ts");

    // Now dynamically switch to optimized analysis! Should NOT panic because self.compiler is always initialized.
    let iter2 = analyzer.analyze_optimized().unwrap();
    let res2 = futures::executor::block_on(iter2.next()).unwrap();
    assert!(res2.is_some());
    assert_eq!(res2.unwrap().files[0].file_path, "/project/app.ts");
}

#[test]
fn test_utf16_imports_end() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        "// José is here 😊\nimport {Component} from '@angular/core';\n@Component({\n    selector: 'app-root',\n    template: '<h1>Hello</h1>'\n})\nexport class AppComponent {}\n"
            .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze().unwrap();
    while futures::executor::block_on(iterator.next())
        .unwrap()
        .is_some()
    {}

    let result = analyzer.get_metadata_for_file("/project/app.ts".to_string());
    assert!(result.is_some());
    let analysis = result.unwrap();

    // Expected UTF-16 offset of the end of the import block:
    // "// José is here 😊\n" -> 19 chars (é is 1, 😊 is 2)
    // "import {Component} from '@angular/core';\n" -> 40 chars (without newline)
    // The span.end of the import statement points to the character after ';', which is '\n' at index 59.
    // Total UTF-16 offset = 59.
    // UTF-8 offset would be 62.
    assert_eq!(analysis.imports_end, 59);
}

#[test]
fn test_injectable_with_deps() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Injectable, Optional, Self, SkipSelf, Host, Inject, InjectionToken} from '@angular/core';
            const MY_TOKEN = new InjectionToken('MY_TOKEN');
            @Injectable({
                providedIn: 'root',
                useFactory: (a: any, b: any, c: any, d: any, e: any, f: any, g: any) => {},
                deps: [
                    SomeService,
                    [new Optional(), OptionalService],
                    [new Self(), SelfService],
                    [new SkipSelf(), SkipSelfService],
                    [new Host(), HostService],
                    [new Inject(MY_TOKEN)],
                    [new Optional(), new Inject(MY_TOKEN)],
                ]
            })
            export class MyService {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze().unwrap();
    let _res = futures::executor::block_on(iterator.next()).unwrap();

    let metadata = analyzer
        .get_metadata_for_file("/project/app.ts".to_string())
        .unwrap();
    let class_meta = &metadata.classes[0];

    let injectable = class_meta.injectable.as_ref().unwrap();
    let deps = injectable.deps.as_ref().unwrap();

    assert_eq!(deps.len(), 7);

    let content = analyzer
        .get_file_content("/project/app.ts".to_string())
        .unwrap();
    let get_token = |span: crate::types::metadata::SpanMetadata| {
        content[span.start as usize..span.end as usize].to_string()
    };

    // SomeService
    assert_eq!(get_token(deps[0].token_span.unwrap()), "SomeService");
    assert!(!deps[0].optional);
    assert!(!deps[0].self_qualifier);
    assert!(!deps[0].skip_self);
    assert!(!deps[0].host);

    // [new Optional(), OptionalService]
    assert_eq!(get_token(deps[1].token_span.unwrap()), "OptionalService");
    assert!(deps[1].optional);
    assert!(!deps[1].self_qualifier);
    assert!(!deps[1].skip_self);
    assert!(!deps[1].host);

    // [new Self(), SelfService]
    assert_eq!(get_token(deps[2].token_span.unwrap()), "SelfService");
    assert!(!deps[2].optional);
    assert!(deps[2].self_qualifier);
    assert!(!deps[2].skip_self);
    assert!(!deps[2].host);

    // [new SkipSelf(), SkipSelfService]
    assert_eq!(get_token(deps[3].token_span.unwrap()), "SkipSelfService");
    assert!(!deps[3].optional);
    assert!(!deps[3].self_qualifier);
    assert!(deps[3].skip_self);
    assert!(!deps[3].host);

    // [new Host(), HostService]
    assert_eq!(get_token(deps[4].token_span.unwrap()), "HostService");
    assert!(!deps[4].optional);
    assert!(!deps[4].self_qualifier);
    assert!(!deps[4].skip_self);
    assert!(!deps[4].host);

    // [new Inject(MY_TOKEN)]
    assert_eq!(get_token(deps[5].token_span.unwrap()), "MY_TOKEN");
    assert!(!deps[5].optional);
    assert!(!deps[5].self_qualifier);
    assert!(!deps[5].skip_self);
    assert!(!deps[5].host);

    // [new Optional(), new Inject(MY_TOKEN)]
    assert_eq!(get_token(deps[6].token_span.unwrap()), "MY_TOKEN");
    assert!(deps[6].optional);
    assert!(!deps[6].self_qualifier);
    assert!(!deps[6].skip_self);
    assert!(!deps[6].host);
}

#[test]
fn test_allowed_sources_allows_dts() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component, NgModule} from '@angular/core';
            import {ActivatedRoute, RouterModule} from './router';

            @Component({
                selector: 'app-root',
                template: '<h1>Hello</h1>',
                standalone: false,
            })
            export class AppComponent {
                constructor(private route: ActivatedRoute) {}
            }

            @NgModule({
                declarations: [AppComponent],
                imports: [RouterModule.forRoot([])],
                bootstrap: [AppComponent]
            })
            export class AppModule {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/router.d.ts".to_string(),
        r#"
            import * as i0 from '@angular/core';
            export declare class ActivatedRoute {
                static ɵprov: any;
            }
            export declare class RouterModule {
                static forRoot(routes: any[]): i0.ModuleWithProviders<RouterModule>;
                static ɵmod: i0.ɵɵNgModuleDeclaration<RouterModule, never, never, never>;
            }
        "#
        .to_string(),
    );

    // Only allow tsconfig.json and app.ts (blocked: router.d.ts)
    let allowed_sources = vec![
        "/project/tsconfig.json".to_string(),
        "/project/app.ts".to_string(),
    ];

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        node_modules_path_override: None,
        allowed_sources: Some(allowed_sources),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze_optimized().unwrap();

    let mut results = Vec::new();
    while let Some(chunk) = futures::executor::block_on(iterator.next()).unwrap() {
        for file in chunk.files {
            results.push(file);
        }
    }

    // Verify that the imports of AppModule are resolved successfully and not treated as Dynamic!
    let app_module_analysis = results
        .iter()
        .find(|res| res.file_path == "/project/app.ts")
        .unwrap();
    let app_module_class = app_module_analysis
        .classes
        .iter()
        .find(|c| c.class_name.as_deref() == Some("AppModule"))
        .unwrap();
    let ng_module = app_module_class
        .ng_module
        .as_ref()
        .expect("AppModule should be an NgModule");
    let imports = ng_module
        .imports
        .as_ref()
        .expect("AppModule should have imports");

    // We expect RouterModule to be in the imports list, resolved as imported!
    assert_eq!(imports.len(), 1);
    let importable = imports[0]
        .typecheck_import
        .as_ref()
        .expect("RouterModule is declared in another file");
    assert_eq!(importable.symbol, "RouterModule");
    assert_eq!(importable.specifier, "./router");
}

#[test]
fn test_resource_files_in_entrypoints_and_metadata() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts", "app.component.html", "app.component.css"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            @Component({
                templateUrl: './app.component.html',
                styleUrls: ['./app.component.css']
            })
            export class AppComponent {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.component.html".to_string(),
        "<h1>Hello</h1>".to_string(),
    );
    virtual_files.insert(
        "/project/app.component.css".to_string(),
        ".app-component { background-color: color(from var(--primary) srgb r g b/.38); }"
            .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Arc::new(Analyzer::new(options).unwrap());

    // Asking for metadata on the TS file returns the component analysis without attempting to parse resource files
    let ts_meta = analyzer
        .get_metadata_for_file("/project/app.ts".to_string())
        .expect("app.ts should return valid metadata");
    assert_eq!(ts_meta.classes.len(), 1);
    assert_eq!(
        ts_meta.classes[0].class_name.as_deref(),
        Some("AppComponent")
    );
}

#[test]
#[should_panic(expected = "get_metadata_for_file must only be called on TS/JS source files")]
fn test_get_metadata_for_file_on_resource_panics() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts"]}"#.to_string(),
    );
    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };
    let analyzer = Analyzer::new(options).unwrap();
    analyzer.get_metadata_for_file("/project/app.component.css".to_string());
}

#[test]
fn test_ngmodule_array_spread_imports_resolution() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts", "extra_modules.ts", "module_a.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/module_a.ts".to_string(),
        r#"
            import {NgModule} from '@angular/core';
            @NgModule({})
            export class ModuleA {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/extra_modules.ts".to_string(),
        r#"
            import {NgModule} from '@angular/core';
            @NgModule({})
            export class ModuleB {}
            export const ExtraModules = [ModuleB];
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component, NgModule} from '@angular/core';
            import {ModuleA} from './module_a';
            import {ExtraModules} from './extra_modules';

            @Component({
                selector: 'my-comp',
                template: '<div>Test</div>',
                standalone: true,
            })
            export class MyComponent {}

            @NgModule({
                imports: [
                    ModuleA,
                    ...ExtraModules,
                    MyComponent,
                ],
                exports: [
                    MyComponent,
                ],
            })
            export class MyModule {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze_optimized().unwrap();

    let mut results = Vec::new();
    while let Some(chunk) = futures::executor::block_on(iterator.next()).unwrap() {
        for file in chunk.files {
            results.push(file);
        }
    }

    let app_meta = results
        .iter()
        .find(|res| res.file_path == "/project/app.ts")
        .unwrap();
    let my_module = app_meta
        .classes
        .iter()
        .find(|c| c.class_name.as_deref() == Some("MyModule"))
        .unwrap();
    let ng_module = my_module.ng_module.as_ref().expect("MyModule metadata");
    let imports = ng_module.imports.as_ref().expect("imports metadata");
    let names: Vec<&str> = imports
        .iter()
        .map(|r| {
            r.local_alias
                .as_deref()
                .or_else(|| r.typecheck_import.as_ref().map(|i| i.symbol.as_str()))
                .unwrap()
        })
        .collect();

    assert_eq!(names, vec!["ModuleA", "ModuleB", "MyComponent"]);
}

#[test]
fn test_ngmodule_dts_tuple_typeof_array_spread() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts", "extra_modules.d.ts", "modules.d.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/modules.d.ts".to_string(),
        r#"
            import * as i0 from '@angular/core';
            export declare class ModuleC {
                static ɵmod: i0.ɵɵNgModuleDeclaration<ModuleC, never, never, never>;
            }
            export declare class ModuleD {
                static ɵmod: i0.ɵɵNgModuleDeclaration<ModuleD, never, never, never>;
            }
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/extra_modules.d.ts".to_string(),
        r#"
            import {ModuleC, ModuleD} from './modules';
            export declare const ExtraModules: [typeof ModuleC, typeof ModuleD];
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component, NgModule} from '@angular/core';
            import {ExtraModules} from './extra_modules';

            @Component({
                selector: 'my-comp',
                template: '<div>Test</div>',
                standalone: true,
            })
            export class MyComponent {}

            @NgModule({
                imports: [
                    ...ExtraModules,
                    MyComponent,
                ],
                exports: [
                    MyComponent,
                ],
            })
            export class MyModule {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze_optimized().unwrap();

    let mut results = Vec::new();
    while let Ok(Some(chunk)) = futures::executor::block_on(iterator.next()) {
        for file in chunk.files {
            results.push(file);
        }
    }

    let file_paths: Vec<&str> = results.iter().map(|res| res.file_path.as_str()).collect();
    println!("results file_paths: {:?}", file_paths);
    let app_meta = results
        .iter()
        .find(|res| res.file_path == "/project/app.ts")
        .expect("app.ts metadata");
    let my_module = app_meta
        .classes
        .iter()
        .find(|c| c.class_name.as_deref() == Some("MyModule"))
        .unwrap();
    let ng_module = my_module.ng_module.as_ref().expect("MyModule metadata");
    let imports = ng_module
        .imports
        .as_ref()
        .expect("imports metadata should exist");
    let names: Vec<&str> = imports
        .iter()
        .map(|r| {
            r.local_alias
                .as_deref()
                .or_else(|| r.typecheck_import.as_ref().map(|i| i.symbol.as_str()))
                .unwrap()
        })
        .collect();

    assert_eq!(names, vec!["ModuleC", "ModuleD", "MyComponent"]);
}

#[test]
fn test_component_dts_readonly_tuple_typeof_array_spread() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts", "directives.d.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/directives.d.ts".to_string(),
        r#"
            import * as i0 from '@angular/core';
            export declare class DirA {
                static ɵdir: i0.ɵɵDirectiveDeclaration<DirA, '[dirA]', never, {}, {}, never, never, true>;
            }
            export declare class DirB {
                static ɵdir: i0.ɵɵDirectiveDeclaration<DirB, '[dirB]', never, {}, {}, never, never, true>;
            }
            export declare const READONLY_DEPS: readonly [typeof DirA, typeof DirB];
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            import {READONLY_DEPS} from './directives';

            @Component({
                selector: 'my-comp',
                template: '<div dirA dirB>Test</div>',
                standalone: true,
                imports: [
                    ...READONLY_DEPS,
                ],
            })
            export class MyComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze_optimized().unwrap();

    let mut results = Vec::new();
    while let Ok(Some(chunk)) = futures::executor::block_on(iterator.next()) {
        for file in chunk.files {
            results.push(file);
        }
    }

    let app_meta = results
        .iter()
        .find(|res| res.file_path == "/project/app.ts")
        .expect("app.ts metadata");
    let my_component = app_meta
        .classes
        .iter()
        .find(|c| c.class_name.as_deref() == Some("MyComponent"))
        .unwrap();
    let component = my_component
        .component
        .as_ref()
        .expect("MyComponent metadata");
    assert!(component.raw_imports_span.is_none());
    let decls = component
        .resolved_declarations
        .as_ref()
        .expect("resolved_declarations should exist");
    let names: Vec<&str> = decls.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, vec!["DirA", "DirB"]);
}

#[test]
fn test_unresolvable_selector_diagnostic() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';
            const DYNAMIC_SELECTOR = 'app-' + Math.random();

            @Component({
                selector: DYNAMIC_SELECTOR,
                template: '<div></div>',
                standalone: true,
            })
            export class BadComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 1010);
    assert_eq!(diag.category, 1);
    assert_eq!(diag.message_text, "selector must be a string");
}

#[test]
fn test_invalid_style_urls_diagnostic_ng2021() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'app-bad-styles',
                template: '<div></div>',
                styleUrl: './single.css',
                styleUrls: ['./multiple.css'],
                standalone: true,
            })
            export class BadStylesComponent {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/single.css".to_string(),
        ".single { color: red; }".to_string(),
    );
    virtual_files.insert(
        "/project/multiple.css".to_string(),
        ".multiple { color: blue; }".to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 2021);
    assert_eq!(diag.category, 1);
    assert_eq!(
        diag.message_text,
        "@Component cannot define both `styleUrl` and `styleUrls`. Use `styleUrl` if the component has one stylesheet, or `styleUrls` if it has multiple"
    );
}

#[test]
fn test_missing_template_resource_diagnostic_ng2008() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'app-missing-template',
                templateUrl: './nonexistent.html',
                standalone: true,
            })
            export class MissingTemplateComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 2008);
    assert_eq!(diag.category, 1);
    assert!(diag
        .message_text
        .contains("Could not find template file './nonexistent.html'."));
}

#[test]
fn test_missing_style_resource_diagnostic_ng2008() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'app-missing-style',
                template: '<div></div>',
                styleUrl: './nonexistent.css',
                standalone: true,
            })
            export class MissingStyleComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 2008);
    assert_eq!(diag.category, 1);
    assert!(diag
        .message_text
        .contains("Could not find stylesheet file './nonexistent.css'."));
}

#[test]
fn test_missing_pipe_name_diagnostic_ng2002() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["test.pipe.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/test.pipe.ts".to_string(),
        r#"
            import { Pipe, PipeTransform } from '@angular/core';

            @Pipe({
                pure: true,
            })
            export class NamelessPipe implements PipeTransform {
                transform(value: any) { return value; }
            }
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/test.pipe.ts".to_string());
    let meta = res.expect("test.pipe.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 2002);
    assert_eq!(diag.category, 1);
    assert!(diag
        .message_text
        .contains("@Pipe decorator is missing name field"));
}

#[test]
fn test_missing_directive_selector_diagnostic_ng2004() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["test.directive.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/test.directive.ts".to_string(),
        r#"
            import { Directive } from '@angular/core';

            @Directive({
                selector: '',
            })
            export class EmptySelectorDirective {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/test.directive.ts".to_string());
    let meta = res.expect("test.directive.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 2004);
    assert_eq!(diag.category, 1);
    assert!(diag
        .message_text
        .contains("Directive EmptySelectorDirective has no selector, please add it!"));
}

#[test]
fn test_cross_file_selector_in_optimized_mode() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts", "constants.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/constants.ts".to_string(),
        r#"export const SELECTOR = 'app-custom';"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';
            import { SELECTOR } from './constants';

            @Component({
                selector: SELECTOR,
                template: '<div></div>',
                standalone: true,
            })
            export class CustomComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    assert_eq!(meta.diagnostics.len(), 0);
    assert_eq!(
        meta.classes[0].component.as_ref().unwrap().selector,
        Some("app-custom".to_string())
    );
}

#[test]
fn test_cross_file_selector_in_non_optimized_mode() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts", "constants.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/constants.ts".to_string(),
        r#"export const SELECTOR = 'app-custom';"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';
            import { SELECTOR } from './constants';

            @Component({
                selector: SELECTOR,
                template: '<div></div>',
                standalone: true,
            })
            export class CustomComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze().unwrap();
    let mut all_files = Vec::new();
    while let Ok(Some(chunk)) = futures::executor::block_on(iterator.next()) {
        all_files.extend(chunk.files);
    }

    let app_meta = all_files
        .iter()
        .find(|f| f.file_path.contains("app.component.ts"))
        .expect("app.component.ts in chunk");

    assert_eq!(app_meta.diagnostics.len(), 1);
    assert_eq!(app_meta.diagnostics[0].code, 1010);
    assert_eq!(
        app_meta.diagnostics[0].message_text,
        "selector must be a string"
    );
}

#[test]
fn test_cross_file_invalid_selector_in_optimized_mode() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts", "constants.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/constants.ts".to_string(),
        r#"export const SELECTOR = 12345;"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';
            import { SELECTOR } from './constants';

            @Component({
                selector: SELECTOR,
                template: '<div></div>',
                standalone: true,
            })
            export class BadCustomComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    assert_eq!(meta.diagnostics[0].code, 1010);
    assert_eq!(
        meta.diagnostics[0].message_text,
        "selector must be a string"
    );
}

#[test]
fn test_cross_file_empty_directive_selector_in_optimized_mode() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["test.directive.ts", "constants.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/constants.ts".to_string(),
        r#"export const EMPTY_SEL = '';"#.to_string(),
    );
    virtual_files.insert(
        "/project/test.directive.ts".to_string(),
        r#"
            import { Directive } from '@angular/core';
            import { EMPTY_SEL } from './constants';

            @Directive({
                selector: EMPTY_SEL,
            })
            export class EmptyConstDirective {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/test.directive.ts".to_string());
    let meta = res.expect("test.directive.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    assert_eq!(meta.diagnostics[0].code, 2004);
    assert!(meta.diagnostics[0]
        .message_text
        .contains("Directive EmptyConstDirective has no selector, please add it!"));
}

#[test]
fn test_shadow_dom_selector_diagnostics_ng2009() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["no-hyphen.component.ts", "upper-case.component.ts", "attr-selector.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/no-hyphen.component.ts".to_string(),
        r#"
            import { Component, ViewEncapsulation } from '@angular/core';

            @Component({
                selector: 'widget',
                template: '<div></div>',
                encapsulation: ViewEncapsulation.ShadowDom,
                standalone: true,
            })
            export class NoHyphenComponent {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/upper-case.component.ts".to_string(),
        r#"
            import { Component, ViewEncapsulation } from '@angular/core';

            @Component({
                selector: 'appWidget',
                template: '<div></div>',
                encapsulation: ViewEncapsulation.ShadowDom,
                standalone: true,
            })
            export class UpperCaseComponent {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/attr-selector.component.ts".to_string(),
        r#"
            import { Component, ViewEncapsulation } from '@angular/core';

            @Component({
                selector: 'widget[foo]',
                template: '<div></div>',
                encapsulation: ViewEncapsulation.ShadowDom,
                standalone: true,
            })
            export class AttrSelectorComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();

    let meta = analyzer
        .get_metadata_for_file("/project/no-hyphen.component.ts".to_string())
        .expect("no-hyphen metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    assert_eq!(meta.diagnostics[0].code, 2009);
    assert_eq!(
        meta.diagnostics[0].message_text,
        "Selector of a component that uses ViewEncapsulation.ShadowDom must contain a hyphen."
    );

    let meta = analyzer
        .get_metadata_for_file("/project/upper-case.component.ts".to_string())
        .expect("upper-case metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    assert_eq!(meta.diagnostics[0].code, 2009);
    assert_eq!(
        meta.diagnostics[0].message_text,
        "Selector of a ShadowDom-encapsulated component must all be in lower case."
    );

    // Attribute selectors are deliberately exempt, matching the reference's escape hatch.
    let meta = analyzer
        .get_metadata_for_file("/project/attr-selector.component.ts".to_string())
        .expect("attr-selector metadata");
    assert_eq!(meta.diagnostics.len(), 0);
}

#[test]
fn test_pipe_field_diagnostics_ng1010() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["bad.pipe.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/bad.pipe.ts".to_string(),
        r#"
            import { Pipe } from '@angular/core';

            declare function pipeName(): string;
            declare function isPure(): boolean;

            @Pipe({
                name: pipeName(),
                pure: isPure(),
            })
            export class BadPipe {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let meta = analyzer
        .get_metadata_for_file("/project/bad.pipe.ts".to_string())
        .expect("bad.pipe.ts metadata");
    let messages: Vec<_> = meta
        .diagnostics
        .iter()
        .map(|d| {
            assert_eq!(d.code, 1010);
            d.message_text.as_str()
        })
        .collect();
    assert_eq!(
        messages,
        vec![
            "@Pipe.name must be a string",
            "@Pipe.pure must be a boolean"
        ]
    );
}

#[test]
fn test_empty_pipe_name_is_not_missing() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["empty.pipe.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/empty.pipe.ts".to_string(),
        r#"
            import { Pipe } from '@angular/core';

            @Pipe({
                name: '',
            })
            export class EmptyNamePipe {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let meta = analyzer
        .get_metadata_for_file("/project/empty.pipe.ts".to_string())
        .expect("empty.pipe.ts metadata");
    // ngtsc's pipe handler accepts an empty string as a name — NG2002 is only for a
    // missing `name` property.
    assert_eq!(meta.diagnostics.len(), 0);
}

#[test]
fn test_dynamic_standalone_flag_diagnostic_ng1010() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["bad.directive.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/bad.directive.ts".to_string(),
        r#"
            import { Directive } from '@angular/core';

            declare function isStandalone(): boolean;

            @Directive({
                selector: '[appBad]',
                standalone: isStandalone(),
            })
            export class BadDirective {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let meta = analyzer
        .get_metadata_for_file("/project/bad.directive.ts".to_string())
        .expect("bad.directive.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    assert_eq!(meta.diagnostics[0].code, 1010);
    assert_eq!(
        meta.diagnostics[0].message_text,
        "standalone flag must be a boolean"
    );
}

#[test]
fn test_dynamic_host_listener_args_diagnostic_ng1010() {
    // Matches ngtsc behavior in:
    // packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L742-L754
    // packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L1091-L1105
    // where isStringArrayOrDie rejects @HostListener arguments that do not statically
    // resolve to a string array with ErrorCode.VALUE_HAS_WRONG_TYPE (NG1010).
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["bad.directive.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/bad.directive.ts".to_string(),
        r#"
            import { Directive, HostListener } from '@angular/core';

            declare function getArg(): string;

            @Directive({
                selector: '[appBad]',
                standalone: true,
            })
            export class BadDirective {
                @HostListener('click', [getArg()])
                onClick(arg: any) {}
            }
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let meta = analyzer
        .get_metadata_for_file("/project/bad.directive.ts".to_string())
        .expect("bad.directive.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    assert_eq!(meta.diagnostics[0].code, 1010);
    assert_eq!(
        meta.diagnostics[0].message_text,
        "Failed to resolve @HostListener.args at position 0 to a string"
    );
}

#[test]
fn test_non_array_host_listener_args_diagnostic_ng1010() {
    // Matches ngtsc behavior in:
    // packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L742-L754
    // where @HostListener rejects a second argument that is not a string array
    // with ErrorCode.VALUE_HAS_WRONG_TYPE (NG1010).
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["bad.directive.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/bad.directive.ts".to_string(),
        r#"
            import { Directive, HostListener } from '@angular/core';

            @Directive({
                selector: '[appBad]',
                standalone: true,
            })
            export class BadDirective {
                @HostListener('click', 'notAnArray' as any)
                onClick() {}
            }
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let meta = analyzer
        .get_metadata_for_file("/project/bad.directive.ts".to_string())
        .expect("bad.directive.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    assert_eq!(meta.diagnostics[0].code, 1010);
    assert_eq!(
        meta.diagnostics[0].message_text,
        "@HostListener's second argument must be a string array"
    );
}

#[test]
fn test_missing_template_diagnostic_ng2001() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'app-root',
                standalone: true,
            })
            export class AppComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 2001);
    assert_eq!(diag.category, 1);
    assert_eq!(
        diag.message_text,
        "@Component is missing a template. Add either a `template` or `templateUrl`"
    );
}

#[test]
fn test_dynamic_template_diagnostic_ng1010() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'app-root',
                template: '<div>' + Math.random() + '</div>',
                standalone: true,
            })
            export class AppComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 1010);
    assert_eq!(diag.category, 1);
    assert_eq!(diag.message_text, "template must be a string");
}

#[test]
fn test_dynamic_template_url_diagnostic_ng1010() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'app-root',
                templateUrl: './app-' + Math.random() + '.html',
                standalone: true,
            })
            export class AppComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 1010);
    assert_eq!(diag.category, 1);
    assert_eq!(diag.message_text, "templateUrl must be a string");
}

#[test]
fn test_template_url_takes_precedence_over_dynamic_template() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'app-root',
                templateUrl: './app.component.html',
                template: '<div>' + Math.random() + '</div>',
                standalone: true,
            })
            export class AppComponent {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.component.html".to_string(),
        "<span>ok</span>".to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    // ngtsc's parseTemplateDeclaration never inspects `template` when `templateUrl` is
    // present, so the dynamic inline template is not an error here.
    assert_eq!(meta.diagnostics.len(), 0);
}

#[test]
fn test_foreign_imports_shape_diagnostics_ng1010() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            declare const bad: unknown;
            declare function two(a: unknown, b: unknown): unknown;
            declare const obj: { member(c: unknown): unknown };
            declare function fn(x: unknown): unknown;
            declare function ok(x: unknown): unknown;
            declare const A: unknown, B: unknown, C: unknown;
            declare const x: { y: unknown };
            declare class Kept {}

            @Component({
                selector: 'app-root',
                template: '<div></div>',
                standalone: true,
                foreignImports: [bad, two(A, B), obj.member(C), fn(x.y), ok(Kept)],
            })
            export class AppComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");

    let messages: Vec<_> = meta
        .diagnostics
        .iter()
        .map(|d| {
            assert_eq!(d.code, 1010);
            assert_eq!(d.category, 1);
            d.message_text.as_str()
        })
        .collect();
    assert_eq!(
        messages,
        vec![
            "Each foreign import must be a call expression, e.g. 'myImport(MyComponent)'.",
            "Foreign import calls must receive exactly one argument, e.g. 'myImport(MyComponent)'.",
            "The foreign import function must be a simple identifier, e.g. 'myImport(MyComponent)'.",
            "The component reference passed to the foreign import must be a simple identifier, e.g. 'myImport(MyComponent)'.",
        ]
    );

    // The well-formed trailing entry is still extracted.
    let component = meta.classes[0].component.as_ref().unwrap();
    let foreign = component.foreign_imports.as_ref().unwrap();
    assert_eq!(foreign.len(), 1);
    assert_eq!(foreign[0].name, "Kept");
}

#[test]
fn test_foreign_imports_non_array_diagnostic_ng1010() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            declare const SHARED_IMPORTS: unknown;

            @Component({
                selector: 'app-root',
                template: '<div></div>',
                standalone: true,
                foreignImports: SHARED_IMPORTS,
            })
            export class AppComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 1010);
    assert_eq!(diag.category, 1);
    assert_eq!(
        diag.message_text,
        "'foreignImports' must be an array of foreign imports, e.g. 'foreignImports: [myImport(MyComponent)]'."
    );
}

#[test]
fn test_imports_on_non_standalone_component_ng2010() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'app-other',
                template: '<span></span>',
                standalone: true,
            })
            export class OtherComponent {}

            @Component({
                selector: 'app-root',
                template: '<div></div>',
                standalone: false,
                imports: [OtherComponent],
            })
            export class AppComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 2010);
    assert_eq!(diag.category, 1);
    assert_eq!(
        diag.message_text,
        "'imports' is only valid on a component that is standalone."
    );
}

#[test]
fn test_foreign_imports_on_non_standalone_component_ng2010() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/app.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            declare const bad: unknown;

            @Component({
                selector: 'app-root',
                template: '<div></div>',
                standalone: false,
                foreignImports: [bad],
            })
            export class AppComponent {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let res = analyzer.get_metadata_for_file("/project/app.component.ts".to_string());
    let meta = res.expect("app.component.ts metadata");
    // ngtsc reports only the standalone violation and poisons the component, so the
    // malformed-entry NG1010s do not fire alongside it.
    assert_eq!(meta.diagnostics.len(), 1);
    let diag = &meta.diagnostics[0];
    assert_eq!(diag.code, 2010);
    assert_eq!(diag.category, 1);
    assert_eq!(
        diag.message_text,
        "'foreignImports' is only valid on a component that is standalone."
    );
}

#[test]
fn test_compilation_chunk_with_prefix_imports_and_cycles() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"compilerOptions": {"rootDirs": ["/project"], "paths": {"google3/*": ["*"]}}, "files": ["app.module.ts", "a.component.ts", "b.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/a.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'comp-a',
                template: '<comp-b></comp-b>',
                standalone: false,
            })
            export class CompA {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/b.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'comp-b',
                template: '<comp-a></comp-a>',
                standalone: false,
            })
            export class CompB {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.module.ts".to_string(),
        r#"
            import { NgModule } from '@angular/core';
            import { CompA } from 'google3/a.component';
            import { CompB } from 'google3/b.component';

            @NgModule({
                declarations: [CompA, CompB],
                exports: [CompA, CompB],
            })
            export class AppModule {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        workspace_name: Some("google3".to_string()),
        root_dirs: Some(vec!["/project".to_string()]),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze_optimized().unwrap();

    let mut chunks = Vec::new();
    while let Some(chunk) = futures::executor::block_on(iterator.next()).unwrap() {
        chunks.push(chunk);
    }

    assert_eq!(
        chunks.len(),
        1,
        "Expected all declared files to be in a single chunk"
    );
    assert_eq!(
        chunks[0].files.len(),
        3,
        "Chunk should contain AppModule, CompA, and CompB"
    );

    let file_paths: Vec<&str> = chunks[0]
        .files
        .iter()
        .map(|f| f.file_path.as_str())
        .collect();
    assert!(file_paths.contains(&"/project/app.module.ts"));
    assert!(file_paths.contains(&"/project/a.component.ts"));
    assert!(file_paths.contains(&"/project/b.component.ts"));
}

#[test]
fn test_compilation_chunk_with_tsconfig_paths() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{
            "compilerOptions": {
                "baseUrl": ".",
                "paths": {
                    "@components/*": ["components/*"]
                }
            },
            "files": ["app.module.ts", "components/a.component.ts", "components/b.component.ts"]
        }"#
        .to_string(),
    );
    virtual_files.insert(
        "/project/components/a.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'comp-a',
                template: '<div>A</div>',
                standalone: false,
            })
            export class CompA {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/components/b.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'comp-b',
                template: '<div>B</div>',
                standalone: false,
            })
            export class CompB {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.module.ts".to_string(),
        r#"
            import { NgModule } from '@angular/core';
            import { CompA } from '@components/a.component';
            import { CompB } from '@components/b.component';

            @NgModule({
                declarations: [CompA, CompB],
                exports: [CompA, CompB],
            })
            export class AppModule {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze_optimized().unwrap();

    let mut chunks = Vec::new();
    while let Some(chunk) = futures::executor::block_on(iterator.next()).unwrap() {
        chunks.push(chunk);
    }

    assert_eq!(
        chunks.len(),
        1,
        "Expected all declared files to be in a single chunk"
    );
    assert_eq!(
        chunks[0].files.len(),
        3,
        "Chunk should contain AppModule, CompA, and CompB"
    );

    let file_paths: Vec<&str> = chunks[0]
        .files
        .iter()
        .map(|f| f.file_path.as_str())
        .collect();
    assert!(file_paths.contains(&"/project/app.module.ts"));
    assert!(file_paths.contains(&"/project/components/a.component.ts"));
    assert!(file_paths.contains(&"/project/components/b.component.ts"));
}

#[test]
fn test_syntax_mode_emits_one_file_per_chunk() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.module.ts", "a.component.ts", "b.component.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/a.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'comp-a',
                template: '<div>A</div>',
                standalone: false,
            })
            export class CompA {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/b.component.ts".to_string(),
        r#"
            import { Component } from '@angular/core';

            @Component({
                selector: 'comp-b',
                template: '<div>B</div>',
                standalone: false,
            })
            export class CompB {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.module.ts".to_string(),
        r#"
            import { NgModule } from '@angular/core';
            import { CompA } from './a.component';
            import { CompB } from './b.component';

            @NgModule({
                declarations: [CompA, CompB],
                exports: [CompA, CompB],
            })
            export class AppModule {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(false),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze().unwrap();

    let mut chunks = Vec::new();
    while let Some(chunk) = futures::executor::block_on(iterator.next()).unwrap() {
        chunks.push(chunk);
    }

    assert_eq!(
        chunks.len(),
        3,
        "In syntax mode, every file should be emitted in its own chunk (1 file per chunk)"
    );
    for chunk in &chunks {
        assert_eq!(
            chunk.files.len(),
            1,
            "Each chunk in syntax mode should contain exactly 1 file"
        );
        assert!(
            chunk.static_edges.is_none(),
            "Syntax mode should have no intra-chunk static edges"
        );
    }
}

#[test]
fn test_host_directives_resolved_declarations_cross_file_and_chained() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["components/app.ts", "directives/dir_a.ts", "directives/host_b.ts", "directives/nested/host_c.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/directives/nested/host_c.ts".to_string(),
        r#"
            import {Directive, Input} from '@angular/core';
            @Directive({
                standalone: true,
            })
            export class HostDirC {
                @Input() inputC: string = '';
            }
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/directives/host_b.ts".to_string(),
        r#"
            import {Directive, Input} from '@angular/core';
            import {HostDirC} from './nested/host_c';
            @Directive({
                standalone: true,
                hostDirectives: [{
                    directive: HostDirC,
                    inputs: ['inputC: aliasC'],
                }],
            })
            export class HostDirB {
                @Input() inputB: string = '';
            }
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/directives/dir_a.ts".to_string(),
        r#"
            import {Directive} from '@angular/core';
            import {HostDirB} from './host_b';
            @Directive({
                selector: '[dirA]',
                standalone: true,
                hostDirectives: [{
                    directive: HostDirB,
                    inputs: ['inputB', 'aliasC: finalAliasC'],
                }],
            })
            export class DirA {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/components/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            import {DirA} from '../directives/dir_a';
            @Component({
                selector: 'app-cmp',
                template: '<div dirA [inputB]="val" [finalAliasC]="val"></div>',
                standalone: true,
                imports: [DirA],
            })
            export class AppCmp {
                val = 'hello';
            }
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze_optimized().unwrap();

    let mut results = Vec::new();
    while let Ok(Some(chunk)) = futures::executor::block_on(iterator.next()) {
        for file in chunk.files {
            results.push(file);
        }
    }

    let app_meta = results
        .iter()
        .find(|res| res.file_path == "/project/components/app.ts")
        .expect("app.ts metadata");
    let app_class = app_meta
        .classes
        .iter()
        .find(|c| c.class_name.as_deref() == Some("AppCmp"))
        .unwrap();
    let component = app_class
        .component
        .as_ref()
        .expect("AppCmp component metadata");
    let decls = component
        .resolved_declarations
        .as_ref()
        .expect("resolved_declarations should exist");

    let decl_names: Vec<&str> = decls.iter().map(|d| d.name.as_str()).collect();
    assert!(
        decl_names.contains(&"DirA"),
        "resolved_declarations should contain direct import DirA, got: {:?}",
        decl_names
    );
    assert!(
        decl_names.contains(&"HostDirB"),
        "resolved_declarations should contain direct host directive HostDirB, got: {:?}",
        decl_names
    );
    assert!(
        decl_names.contains(&"HostDirC"),
        "resolved_declarations should contain chained host directive HostDirC, got: {:?}",
        decl_names
    );
}

#[test]
fn test_host_directives_on_component_itself() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts", "host.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/host.ts".to_string(),
        r#"
            import {Directive, Input} from '@angular/core';
            @Directive({
                standalone: true,
            })
            export class HostDir {
                @Input() hostInp: string = '';
            }
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            import {HostDir} from './host';
            @Component({
                selector: 'app-cmp',
                template: '<div>Test</div>',
                standalone: true,
                hostDirectives: [{
                    directive: HostDir,
                    inputs: ['hostInp'],
                }],
            })
            export class AppCmp {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze_optimized().unwrap();

    let mut results = Vec::new();
    while let Ok(Some(chunk)) = futures::executor::block_on(iterator.next()) {
        for file in chunk.files {
            results.push(file);
        }
    }

    let app_meta = results
        .iter()
        .find(|res| res.file_path == "/project/app.ts")
        .expect("app.ts metadata");
    let app_class = app_meta
        .classes
        .iter()
        .find(|c| c.class_name.as_deref() == Some("AppCmp"))
        .unwrap();
    let component = app_class
        .component
        .as_ref()
        .expect("AppCmp component metadata");
    let decls = component
        .resolved_declarations
        .as_ref()
        .expect("resolved_declarations should exist on component with host directives");

    let decl_names: Vec<&str> = decls.iter().map(|d| d.name.as_str()).collect();
    assert!(
        decl_names.contains(&"HostDir"),
        "resolved_declarations should contain component's own host directive HostDir, got: {:?}",
        decl_names
    );
}

#[test]
fn test_host_directives_cycle_prevention() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["app.ts", "dir_a.ts", "dir_b.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/dir_a.ts".to_string(),
        r#"
            import {Directive} from '@angular/core';
            import {DirB} from './dir_b';
            @Directive({
                selector: '[dirA]',
                standalone: true,
                hostDirectives: [DirB],
            })
            export class DirA {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/dir_b.ts".to_string(),
        r#"
            import {Directive} from '@angular/core';
            import {DirA} from './dir_a';
            @Directive({
                selector: '[dirB]',
                standalone: true,
                hostDirectives: [DirA],
            })
            export class DirB {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            import {DirA} from './dir_a';
            @Component({
                selector: 'app-cmp',
                template: '<div dirA></div>',
                standalone: true,
                imports: [DirA],
            })
            export class AppCmp {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze_optimized().unwrap();

    let mut results = Vec::new();
    while let Ok(Some(chunk)) = futures::executor::block_on(iterator.next()) {
        for file in chunk.files {
            results.push(file);
        }
    }

    let app_meta = results
        .iter()
        .find(|res| res.file_path == "/project/app.ts")
        .expect("app.ts metadata");
    let app_class = app_meta
        .classes
        .iter()
        .find(|c| c.class_name.as_deref() == Some("AppCmp"))
        .unwrap();
    let component = app_class
        .component
        .as_ref()
        .expect("AppCmp component metadata");
    let decls = component
        .resolved_declarations
        .as_ref()
        .expect("resolved_declarations should exist");

    let decl_names: Vec<&str> = decls.iter().map(|d| d.name.as_str()).collect();
    assert!(decl_names.contains(&"DirA"));
    assert!(decl_names.contains(&"DirB"));
}

#[test]
fn test_inherited_input_and_output_same_name() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["base.d.ts", "child.d.ts", "app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/base.d.ts".to_string(),
        r#"
            import * as i0 from "@angular/core";
            export declare abstract class BaseSetting<T> {
                static ɵdir: i0.ɵɵDirectiveDeclaration<BaseSetting<any>, never, never, { "value": { "alias": "value"; "required": true; "isSignal": true; }; }, { "value": "valueChange"; }, never, never, true, never>;
            }
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/child.d.ts".to_string(),
        r#"
            import * as i0 from "@angular/core";
            import { BaseSetting } from "./base";
            export declare class ChildControl extends BaseSetting<string> {
                static ɵcmp: i0.ɵɵComponentDeclaration<ChildControl, "child-ctrl", never, {}, {}, never, never, true, never>;
            }
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            import {ChildControl} from './child';
            @Component({
                selector: 'app-cmp',
                template: '<child-ctrl></child-ctrl>',
                standalone: true,
                imports: [ChildControl],
            })
            export class AppCmp {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze_optimized().unwrap();

    let mut results = Vec::new();
    while let Ok(Some(chunk)) = futures::executor::block_on(iterator.next()) {
        for file in chunk.files {
            results.push(file);
        }
    }

    let app_meta = results
        .iter()
        .find(|res| res.file_path == "/project/app.ts")
        .expect("app.ts metadata");
    let app_class = app_meta
        .classes
        .iter()
        .find(|c| c.class_name.as_deref() == Some("AppCmp"))
        .unwrap();
    let component = app_class
        .component
        .as_ref()
        .expect("AppCmp component metadata");
    let decls = component
        .resolved_declarations
        .as_ref()
        .expect("resolved_declarations should exist");

    let child_decl = decls
        .iter()
        .find(|d| d.name == "ChildControl")
        .expect("ChildControl declaration");

    let flattened_fields = child_decl
        .flattened_fields
        .as_ref()
        .expect("flattened_fields should exist");

    let has_input_value = flattened_fields
        .iter()
        .any(|f| f.kind == "input" && f.input.as_ref().map(|i| i.name.as_str()) == Some("value"));
    let has_output_value = flattened_fields
        .iter()
        .any(|f| f.kind == "output" && f.output.as_ref().map(|o| o.name.as_str()) == Some("value"));

    assert!(
        has_input_value,
        "Expected flattened_fields to contain input 'value'"
    );
    assert!(
        has_output_value,
        "Expected flattened_fields to contain output 'value'"
    );
}

#[test]
fn test_inherited_model() {
    let mut virtual_files = HashMap::new();
    virtual_files.insert(
        "/project/tsconfig.json".to_string(),
        r#"{"files": ["base.ts", "child.ts", "app.ts"]}"#.to_string(),
    );
    virtual_files.insert(
        "/project/base.ts".to_string(),
        r#"
            import {Directive, model} from '@angular/core';
            @Directive({selector: '[base]'})
            export class BaseDirective {
                val = model(0);
            }
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/child.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            import {BaseDirective} from './base';
            @Component({
                selector: 'child-cmp',
                template: '',
                standalone: true,
            })
            export class ChildComponent extends BaseDirective {}
        "#
        .to_string(),
    );
    virtual_files.insert(
        "/project/app.ts".to_string(),
        r#"
            import {Component} from '@angular/core';
            import {ChildComponent} from './child';
            @Component({
                selector: 'app-cmp',
                template: '<child-cmp></child-cmp>',
                standalone: true,
                imports: [ChildComponent],
            })
            export class AppCmp {}
        "#
        .to_string(),
    );

    let options = AnalyzerOptions {
        tsconfig_path: "/project/tsconfig.json".to_string(),
        optimize: Some(true),
        virtual_files: Some(virtual_files),
        ..Default::default()
    };

    let analyzer = Analyzer::new(options).unwrap();
    let iterator = analyzer.analyze_optimized().unwrap();

    let mut results = Vec::new();
    while let Ok(Some(chunk)) = futures::executor::block_on(iterator.next()) {
        for file in chunk.files {
            results.push(file);
        }
    }

    let app_meta = results
        .iter()
        .find(|res| res.file_path == "/project/app.ts")
        .expect("app.ts metadata");
    let app_class = app_meta
        .classes
        .iter()
        .find(|c| c.class_name.as_deref() == Some("AppCmp"))
        .unwrap();
    let component = app_class
        .component
        .as_ref()
        .expect("AppCmp component metadata");
    let decls = component
        .resolved_declarations
        .as_ref()
        .expect("resolved_declarations should exist");

    let child_decl = decls
        .iter()
        .find(|d| d.name == "ChildComponent")
        .expect("ChildComponent declaration");

    let flattened_fields = child_decl
        .flattened_fields
        .as_ref()
        .expect("flattened_fields should exist");

    let has_input_val = flattened_fields
        .iter()
        .any(|f| f.kind == "input" && f.input.as_ref().map(|i| i.name.as_str()) == Some("val"));
    let has_output_val = flattened_fields.iter().any(|f| {
        f.kind == "output"
            && f.output.as_ref().map(|o| o.name.as_str()) == Some("val")
            && f.output.as_ref().and_then(|o| o.alias.as_deref()) == Some("valChange")
    });

    assert!(
        has_input_val,
        "Expected flattened_fields to contain input 'val'"
    );
    assert!(
        has_output_val,
        "Expected flattened_fields to contain output 'val' aliased to 'valChange'"
    );
}
