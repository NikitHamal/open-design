import { useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import type { Project } from '../types';
import type { EntryHomeView } from '../router';
import { Icon } from './Icon';
import type { EntrySettingsSection } from './EntrySettingsMenu';

export type EntryView = EntryHomeView;

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
  onOpenSearch?: () => void;
  newProjectDisabled?: boolean;
  open: boolean;
  onOpenSettings?: (section?: EntrySettingsSection) => void;
  recentProjects?: Project[];
  onOpenRecentProject?: (id: string) => void | Promise<unknown>;
  onRenameRecentProject?: (id: string, name: string) => void;
  onDeleteRecentProject?: (id: string) => Promise<boolean | void> | boolean | void;
  onDuplicateRecentProject?: (id: string) => Promise<void> | void;
  // Props the Home shell still passes while its own cleanup is pending.
  [legacy: string]: unknown;
}

const RECENT_OPEN_KEY = 'od.entry.railRecentOpen';
const RECENT_LIMIT = 40;

// The account and billing surfaces are gone; these keep older call sites compiling.
export function workspaceUpgradeUrl(..._args: unknown[]): string | null {
  return null;
}
export function workspaceAutoRechargeUrl(..._args: unknown[]): string | null {
  return null;
}
export function WorkspaceTopRightAccountCluster(_props: Record<string, unknown>): null {
  return null;
}

function NavButton({
  active,
  label,
  onClick,
  testId,
  children,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <span className="entry-nav-rail__btn-icon" aria-hidden>{children}</span>
      <span className="entry-nav-rail__btn-label">{label}</span>
    </button>
  );
}

function readRecentOpen(): boolean {
  try {
    return window.localStorage.getItem(RECENT_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function RecentList({
  projects,
  label,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  projects: Project[];
  label: string;
  onOpen?: Props['onOpenRecentProject'];
  onDuplicate?: Props['onDuplicateRecentProject'];
  onDelete?: Props['onDeleteRecentProject'];
}) {
  const [open, setOpen] = useState(readRecentOpen);
  const [menuId, setMenuId] = useState<string | null>(null);
  if (projects.length === 0) return null;
  const toggle = () => {
    setOpen((value) => {
      try {
        window.localStorage.setItem(RECENT_OPEN_KEY, value ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !value;
    });
  };
  return (
    <div className="entry-nav-rail__recent" data-testid="entry-nav-recent">
      <button
        type="button"
        className="entry-nav-rail__recent-head"
        onClick={toggle}
        aria-expanded={open}
      >
        <span>{label}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {open ? (
        <ul className="entry-nav-rail__recent-list">
          {projects.slice(0, RECENT_LIMIT).map((project) => (
            <li key={project.id} className="entry-nav-rail__recent-row">
              <button
                type="button"
                className="entry-nav-rail__recent-item"
                onClick={() => void onOpen?.(project.id)}
                title={project.name}
              >
                <span className="entry-nav-rail__recent-name">{project.name}</span>
              </button>
              {onDuplicate || onDelete ? (
                <button
                  type="button"
                  className="entry-nav-rail__recent-more"
                  aria-label="More"
                  aria-haspopup="menu"
                  aria-expanded={menuId === project.id}
                  onClick={() => setMenuId((current) => (current === project.id ? null : project.id))}
                >
                  <Icon name="more-horizontal" size={14} />
                </button>
              ) : null}
              {menuId === project.id ? (
                <div className="entry-nav-rail__menu" role="menu">
                  {onDuplicate ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="entry-nav-rail__menu-item"
                      onClick={() => {
                        setMenuId(null);
                        void onDuplicate(project.id);
                      }}
                    >
                      <Icon name="copy" size={15} /> Duplicate
                    </button>
                  ) : null}
                  {onDelete ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="entry-nav-rail__menu-item"
                      onClick={() => {
                        setMenuId(null);
                        if (window.confirm(`Delete "${project.name}"?`)) void onDelete(project.id);
                      }}
                    >
                      <Icon name="trash" size={15} /> Delete
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function EntryNavRail({
  view,
  onViewChange,
  open,
  onOpenSettings,
  recentProjects,
  onOpenRecentProject,
  onDeleteRecentProject,
  onDuplicateRecentProject,
}: Props) {
  const { t } = useI18n();
  return (
    <nav
      className={`entry-nav-rail${open ? ' is-open' : ''}`}
      aria-label={t('entry.primaryNavAria')}
      aria-hidden={open ? undefined : true}
    >
      <div className="entry-nav-rail__panel">
        <div className="entry-nav-rail__group">
          <NavButton active={view === 'home'} label={t('entry.navRecents')} onClick={() => onViewChange('home')} testId="entry-nav-home">
            <Icon name="home" size={16} />
          </NavButton>
          <NavButton
            active={view === 'drafts' || view === 'all-projects'}
            label={t('entry.navDrafts')}
            onClick={() => onViewChange('drafts')}
            testId="entry-nav-drafts"
          >
            <Icon name="file" size={16} />
          </NavButton>
          <NavButton
            active={view === 'design-systems'}
            label={t('entry.navDesignSystems')}
            onClick={() => onViewChange('design-systems')}
            testId="entry-nav-design-systems"
          >
            <Icon name="palette" size={16} />
          </NavButton>
          <NavButton
            active={view === 'plugins'}
            label={t('entry.navPlugins')}
            onClick={() => onViewChange('plugins')}
            testId="entry-nav-plugins"
          >
            <Icon name="puzzle" size={16} />
          </NavButton>
          <NavButton label={t('entry.accountSettings')} onClick={() => onOpenSettings?.()} testId="entry-settings-button">
            <Icon name="settings" size={16} />
          </NavButton>
          <RecentList
            projects={recentProjects ?? []}
            label={t('recentProjects.title')}
            onOpen={onOpenRecentProject}
            onDuplicate={onDuplicateRecentProject}
            onDelete={onDeleteRecentProject}
          />
        </div>
      </div>
    </nav>
  );
}
