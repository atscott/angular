/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

/** Configuration for the signal members migration. */
export interface SignalMembersMigrationConfig {
  /** Optional callback that is invoked when the migration has progress to report. */
  reportProgressFn?: (percentage: number, task: string) => void;

  /**
   * Whether to assume the migration is not running in batch mode.
   * This allows for some optimizations but should be disabled for actual batch runs.
   */
  assumeNonBatch?: boolean;

  // Add any member-specific config options here if they arise.
  // For now, keeping it simple.
}
