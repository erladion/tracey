// trace.yml, edited as text, with what each setting does.
import { useEffect, useState } from 'react';
import { parseConfig, SAMPLE_CONFIG } from '../../../core/config';
import type { Project } from '../project';
import { notify } from '../notify';
import { CodeRepoCard } from './CodeRepoCard';
import { JiraCard } from './JiraCard';
import { VariantsCard } from './VariantsCard';

export function SettingsView({ project }: { project: Project }) {
  const [text, setText] = useState(project.config ?? SAMPLE_CONFIG);
  useEffect(() => setText(project.config ?? SAMPLE_CONFIG), [project.config]);
  const { error, config } = parseConfig(text);
  const dirty = text !== (project.config ?? '');

  return (
    <div className="dashboard settings">
      <div className="dash-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">
            <code>trace.yml</code> at the root of the repository. It’s committed with everything else, so changes go through review like code.
          </p>
        </div>
      </div>
      <JiraCard project={project} />
      <CodeRepoCard project={project} />
      <VariantsCard project={project} blocked={dirty} />
      <div className="dash-columns">
        <section className="card grow">
          <textarea className="config-editor" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="trace.yml" />
          {error && <p className="warn-text">{error}</p>}
          <div className="dialog-actions">
            {!project.config && <span className="muted small">This repository has no trace.yml yet; this is the default.</span>}
            <span className="tool-spacer" />
            <button type="button" className="button" disabled={!dirty} onClick={() => setText(project.config ?? SAMPLE_CONFIG)}>
              Revert
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!dirty || !!error}
              onClick={async () => {
                try {
                  await project.writeConfig(text);
                  await project.reload();
                  notify('Settings saved.', 'success');
                } catch (e) {
                  notify((e as Error).message, 'error');
                }
              }}
            >
              Save
            </button>
          </div>
        </section>
        <aside className="card attention">
          <h2>Now in effect</h2>
          <dl className="settings-summary">
            <dt>Requirements</dt>
            <dd>
              <code>{config.requirements.dir}/</code>, IDs like <code>{config.requirements.prefix + '1'.padStart(config.requirements.digits, '0')}</code>
            </dd>
            <dt>Test cases</dt>
            <dd>
              <code>{config.testcases.dir}/</code>, IDs like <code>{config.testcases.prefix + '1'.padStart(config.testcases.digits, '0')}</code>
            </dd>
            <dt>Requirement statuses</dt>
            <dd>{config.statuses.join(', ')}</dd>
            <dt>Test case statuses</dt>
            <dd>{config.testcaseStatuses.join(', ')}</dd>
            <dt>Components</dt>
            <dd>
              {config.components.length ? (
                <ul className="plain-list">
                  {config.components.map((c) => (
                    <li key={c.key}>
                      <span className="strong">{c.name}</span> <span className="muted mono small">{c.paths.join(', ')}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                'None'
              )}
            </dd>
            <dt>Variants</dt>
            <dd>{config.variants.length ? config.variants.map((v) => v.name).join(', ') : 'None'}</dd>
            <dt>Jira</dt>
            <dd>{config.jiraUrl ?? 'Not set: Jira keys are shown as plain text.'}</dd>
          </dl>
          <p className="muted small">
            “obsolete” items are left out of coverage. A test case lists what it verifies in <code>verifies: [REQ-07]</code>; Tracey records the reviewed text of each
            requirement under <code>reviewed:</code>, and flags the link when the requirement changes.
          </p>
        </aside>
      </div>
    </div>
  );
}
