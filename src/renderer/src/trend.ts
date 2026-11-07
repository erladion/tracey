// Coverage over time: the requirements as they were at each test run's
// requirements-commit, read from git once per commit and kept for the session.
import { useEffect, useState } from 'react';
import { buildIndex, type ProjectIndex } from '../../core/model';
import { trend, type TrendPoint } from '../../core/trend';
import type { Project } from './project';
import { api } from './api';

const cache = new Map<string, Promise<ProjectIndex | null>>();

function indexAt(repo: string, commit: string): Promise<ProjectIndex | null> {
  const key = `${repo}\n${commit}`;
  let p = cache.get(key);
  if (!p) {
    p = api.loadFilesAt(repo, commit).then(
      (f) => (f ? buildIndex(f.files, f.config) : null),
      () => null,
    );
    cache.set(key, p);
  }
  return p;
}

export async function loadTrend(project: Project): Promise<TrendPoint[]> {
  const commits = [...new Set(project.runs.map((r) => r.requirementsCommit).filter((c): c is string => !!c))];
  const found = new Map<string, ProjectIndex | null>();
  await Promise.all(commits.map(async (c) => found.set(c, await indexAt(project.repo.id, c))));
  return trend(project.runs, (run) => (run.requirementsCommit ? (found.get(run.requirementsCommit) ?? null) : null), project.index);
}

// null while reading.
export function useTrend(project: Project): TrendPoint[] | null {
  const [points, setPoints] = useState<TrendPoint[] | null>(null);
  useEffect(() => {
    let live = true;
    loadTrend(project).then(
      (p) => live && setPoints(p),
      () => live && setPoints([]),
    );
    return () => {
      live = false;
    };
    // Again when the runs or the items change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.repo.id, project.runs, project.index]);
  return points;
}
