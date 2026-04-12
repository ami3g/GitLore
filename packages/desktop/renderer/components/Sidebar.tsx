import React from 'react';

export type Page = 'ask' | 'diagrams' | 'index' | 'settings';

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
}

const NAV_ITEMS: { page: Page; icon: string; label: string }[] = [
  { page: 'ask', icon: '💬', label: 'Ask' },
  { page: 'diagrams', icon: '🔀', label: 'Diagrams' },
  { page: 'index', icon: '📚', label: 'Index' },
  { page: 'settings', icon: '⚙️', label: 'Settings' },
];

export const Sidebar: React.FC<SidebarProps> = ({ activePage, onNavigate }) => {
  return (
    <nav className="sidebar">
      <div className="sidebar__logo">
        <span className="sidebar__logo-icon">📜</span>
        <span className="sidebar__logo-text">GitLore</span>
      </div>
      <div className="sidebar__nav">
        {NAV_ITEMS.map(({ page, icon, label }) => (
          <button
            key={page}
            className={`sidebar__item ${activePage === page ? 'sidebar__item--active' : ''}`}
            onClick={() => onNavigate(page)}
            title={label}
          >
            <span className="sidebar__item-icon">{icon}</span>
            <span className="sidebar__item-label">{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
};
