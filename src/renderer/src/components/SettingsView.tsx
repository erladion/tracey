// trace.yml, edited as text, with what each setting does.
import { Fragment, useEffect, useState } from 'react';
import { parseConfig, SAMPLE_CONFIG, typePlural, typeWord } from '../../../core/config';
import type { Project } from '../project';
import { notify } from '../notify';
import { CodeRepoCard } from './CodeRepoCard';
import { JiraCard } from './JiraCard';
import { LlmCard } from './LlmCard';
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
      <LlmCard />
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
            {config.types.map((t) => (
              <Fragment key={t.key}>
                <dt>{t.plural}</dt>
                <dd>
                  <code>{t.dir}/</code>, IDs like <code>{t.prefix + '1'.padStart(t.digits, '0')}</code>
                  <br />
                  <span className="muted small">Statuses: {t.statuses.join(', ')}</span>
                </dd>
              </Fragment>
            ))}
            <dt>Links</dt>
            <dd>
              <ul className="plain-list">
                {config.links.map((l) => (
                  <li key={l.key}>
                    <span className="strong">{l.name}</span>{' '}
                    <span className="muted small">
                      <code>{l.key}:</code> from {l.from.map((k) => typeWord(config, k)).join(' or ')} to {l.to.map((k) => typeWord(config, k)).join(' or ')} · shown as “{l.reverse}”
                    </span>
                  </li>
                ))}
              </ul>
            </dd>
            {config.rules.length > 0 && (
              <>
                <dt>Rules</dt>
                <dd>
                  <ul className="plain-list">
                    {config.rules.map((r, i) => {
                      const l = config.links.find((x) => x.key === r.link)!;
                      return (
                        <li key={i}>
                          Every {typeWord(config, r.type)} {r.incoming ? `is ${l.reverse.toLowerCase()} something` : `${l.name.toLowerCase()} something`}{' '}
                          <span className="muted small">(else: {r.tag})</span>
                        </li>
                      );
                    })}
                  </ul>
                </dd>
              </>
            )}
            {config.notes.length > 0 && (
              <>
                <dt>Not used</dt>
                <dd>
                  <ul className="plain-list">
                    {config.notes.map((n, i) => (
                      <li key={i} className="warn-text small">
                        {n}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
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
            <dt>Fields</dt>
            <dd>
              {config.fields.length ? (
                <ul className="plain-list">
                  {config.fields.map((f) => (
                    <li key={f.key}>
                      <span className="strong">{f.name}</span>{' '}
                      <span className="muted small">
                        {f.type === 'choice' ? `one of ${f.values.join(', ')}` : f.type === 'choices' ? `any of ${f.values.join(', ')}` : f.type}
                        {f.kinds.length < config.types.length ? `, ${f.kinds.map((k) => typePlural(config, k).toLowerCase()).join(' and ')} only` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                'None of your own: other fields in the files are shown read-only.'
              )}
            </dd>
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
