/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  confirmAsSerializable,
  MigrationStats,
  ProgramInfo,
  projectFile,
  ProjectFile,
  Replacement,
  Serializable,
  TextUpdate,
  TsurgeFunnelMigration,
} from '../../utils/tsurge';
import {migrateFile} from './util';

export interface MigrationConfig {
  /**
   * Whether to migrate this component template to self-closing tags.
   */
  shouldMigrate?: (containingFile: ProjectFile) => boolean;
}

export interface FunctionalGuardsMigrationData {
  file: ProjectFile;
  replacementCount: number;
  replacements: Replacement[];
}

export interface FunctionalGuardsCompilationUnitData {
  guardReplacements: Array<FunctionalGuardsMigrationData>;
}

export class FunctionalGuardsMigration extends TsurgeFunnelMigration<
  FunctionalGuardsCompilationUnitData,
  FunctionalGuardsCompilationUnitData
> {
  constructor(private readonly config: MigrationConfig = {}) {
    super();
  }

  override async analyze(
    info: ProgramInfo,
  ): Promise<Serializable<FunctionalGuardsCompilationUnitData>> {
    const {sourceFiles, program} = info;
    const guardReplacements: Array<FunctionalGuardsMigrationData> = [];

    for (const sf of sourceFiles) {
      const file = projectFile(sf, info);
      const rewriter = (startPos: number, origLength: number, text: string) => {
        const replacements = [prepareTextReplacement(file, text, startPos, startPos + origLength)];

        const fileReplacements = guardReplacements.find(
          (tagReplacement) => tagReplacement.file === file,
        );

        if (fileReplacements) {
          fileReplacements.replacements.push(...replacements);
          fileReplacements.replacementCount++;
        } else {
          guardReplacements.push({file, replacements, replacementCount: 1});
        }
      };

      migrateFile(sf, rewriter, program.getTypeChecker());
    }

    return confirmAsSerializable({guardReplacements});
  }

  override async combine(
    unitA: FunctionalGuardsCompilationUnitData,
    unitB: FunctionalGuardsCompilationUnitData,
  ): Promise<Serializable<FunctionalGuardsCompilationUnitData>> {
    const uniqueReplacements = removeDuplicateReplacements([
      ...unitA.guardReplacements,
      ...unitB.guardReplacements,
    ]);

    return confirmAsSerializable({guardReplacements: uniqueReplacements});
  }

  override async globalMeta(
    combinedData: FunctionalGuardsCompilationUnitData,
  ): Promise<Serializable<FunctionalGuardsCompilationUnitData>> {
    const globalMeta: FunctionalGuardsCompilationUnitData = {
      guardReplacements: combinedData.guardReplacements,
    };

    return confirmAsSerializable(globalMeta);
  }

  override async stats(
    globalMetadata: FunctionalGuardsCompilationUnitData,
  ): Promise<MigrationStats> {
    const touchedFilesCount = globalMetadata.guardReplacements.length;
    const replacementCount = globalMetadata.guardReplacements.reduce(
      (acc, cur) => acc + cur.replacementCount,
      0,
    );

    return {
      counters: {
        touchedFilesCount,
        replacementCount,
      },
    };
  }

  override async migrate(globalData: FunctionalGuardsCompilationUnitData) {
    return {replacements: globalData.guardReplacements.flatMap(({replacements}) => replacements)};
  }
}

function prepareTextReplacement(
  file: ProjectFile,
  replacement: string,
  start: number,
  end: number,
): Replacement {
  return new Replacement(
    file,
    new TextUpdate({
      position: start,
      end: end,
      toInsert: replacement,
    }),
  );
}

function removeDuplicateReplacements(
  replacements: FunctionalGuardsMigrationData[],
): FunctionalGuardsMigrationData[] {
  const uniqueFiles = new Set<string>();
  const result: FunctionalGuardsMigrationData[] = [];

  for (const replacement of replacements) {
    const fileId = replacement.file.id;
    if (!uniqueFiles.has(fileId)) {
      uniqueFiles.add(fileId);
      result.push(replacement);
    }
  }

  return result;
}
