#![cfg(feature = "napi")]

use crate::compiler::{AnalysisIterator, Analyzer};
use crate::types::{AnalysisResult, AnalyzerOptions, FileInvalidation, FileUpdate};
use napi_derive::napi;
use std::collections::HashMap;

/// Options for creating a test analyzer
#[napi(object)]
#[derive(Default, Clone, Debug)]
pub struct TestAnalyzerOptions {
    /// Virtual files to use for analysis
    pub virtual_files: HashMap<String, String>,
    /// Whether to use optimized two-pass mode
    pub optimize: Option<bool>,
    /// Path to tsconfig.json (must be a virtual file path)
    pub tsconfig_path: String,
    /// Path to real node_modules for resolving @angular packages
    pub node_modules_path_override: Option<String>,
    /// Workspace name used by `PrefixImportStrategy` (e.g. "google3")
    pub workspace_name: Option<String>,
    /// Root directories for `PrefixImportStrategy`
    pub root_dirs: Option<Vec<String>>,
}

/// Test analyzer that uses virtual filesystem for in-memory testing
#[napi]
pub struct TestAnalyzer {
    analyzer: Analyzer,
}

#[napi]
impl TestAnalyzer {
    #[napi(constructor)]
    pub fn new(options: TestAnalyzerOptions) -> napi::Result<Self> {
        let analyzer = Analyzer::new(AnalyzerOptions {
            tsconfig_path: options.tsconfig_path,
            optimize: options.optimize,
            virtual_files: Some(options.virtual_files),
            node_modules_path_override: options.node_modules_path_override,
            allowed_sources: None,
            workspace_name: options.workspace_name,
            root_dirs: options.root_dirs,
        })?;

        Ok(TestAnalyzer { analyzer })
    }

    #[napi]
    pub fn get_metadata_for_file(&self, file_path: String) -> Option<AnalysisResult> {
        self.analyzer.get_metadata_for_file(file_path)
    }

    #[napi]
    pub fn get_file_content(&self, file_path: String) -> napi::Result<String> {
        self.analyzer.get_file_content(file_path)
    }

    #[napi]
    pub fn get_ts_file_for_template(
        &self,
        template_path: String,
    ) -> Option<Vec<crate::TemplateUsage>> {
        self.analyzer.get_ts_file_for_template(template_path)
    }

    #[napi]
    pub fn update_file_content(&self, updates: Vec<FileUpdate>) -> napi::Result<Vec<String>> {
        self.analyzer.update_file_content(updates)
    }

    #[napi]
    pub fn invalidate_files(&self, updates: Vec<FileInvalidation>) -> napi::Result<Vec<String>> {
        self.analyzer.invalidate_files(updates)
    }

    #[napi]
    pub fn analyze(&self) -> napi::Result<AnalysisIterator> {
        self.analyzer.analyze()
    }

    #[napi]
    pub fn analyze_optimized(&self) -> napi::Result<AnalysisIterator> {
        self.analyzer.analyze_optimized()
    }

    #[napi]
    pub fn analyze_delta(&self) -> napi::Result<AnalysisIterator> {
        self.analyzer.analyze_delta()
    }

    #[napi]
    pub fn analyze_optimized_delta(&self) -> napi::Result<AnalysisIterator> {
        self.analyzer.analyze_optimized_delta()
    }
}
