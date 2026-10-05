import React, { useState, useRef, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { MenuSection, MenuItem } from '../types/editor';

export const DEFAULT_MENU_SECTIONS: MenuSection[] = [
  { id: 'file', label: 'File', items: [] },
  { id: 'edit', label: 'Edit', items: [] },
  { id: 'select', label: 'Select', items: [] },
  { id: 'layer', label: 'Layer', items: [] },
  { id: 'ruler', label: 'Ruler', items: [] },
  { id: 'view', label: 'View', items: [] },
  { id: 'help', label: 'Help', items: [] },
];

interface MenuBarProps {
  sections?: MenuSection[];
}

export const MenuBar: React.FC<MenuBarProps> = ({ sections = DEFAULT_MENU_SECTIONS }) => {
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [activeSubmenuId, setActiveSubmenuId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close active dropdown on pointerdown outside or on Escape
  useEffect(() => {
    if (!activeMenuId) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setActiveMenuId(null);
        setActiveSubmenuId(null);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveMenuId(null);
        setActiveSubmenuId(null);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeMenuId]);

  const handleHeaderClick = (menuId: string) => {
    setActiveMenuId((prev) => (prev === menuId ? null : menuId));
    setActiveSubmenuId(null);
  };

  const handleHeaderMouseEnter = (menuId: string) => {
    // If any menu is currently open, hovering over another top-level section switches to it
    if (activeMenuId !== null && activeMenuId !== menuId) {
      setActiveMenuId(menuId);
      setActiveSubmenuId(null);
    }
  };

  const handleItemClick = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.submenu && item.submenu.length > 0) {
      setActiveSubmenuId((prev) => (prev === item.id ? null : item.id));
      return;
    }
    setActiveMenuId(null);
    setActiveSubmenuId(null);
    if (item.onClick) {
      item.onClick();
    }
  };

  return (
    <nav
      ref={containerRef}
      className="flex items-center space-x-0.5 relative z-50"
      role="menubar"
      aria-label="Application Menu"
    >
      {sections.map((section) => {
        const isOpen = activeMenuId === section.id;

        return (
          <div key={section.id} className="relative">
            <button
              type="button"
              role="menuitem"
              aria-haspopup="true"
              aria-expanded={isOpen}
              onClick={() => handleHeaderClick(section.id)}
              onMouseEnter={() => handleHeaderMouseEnter(section.id)}
              className={`px-2.5 py-1 rounded-[2px] text-xs font-normal transition-colors select-none ${
                isOpen
                  ? 'bg-[#37373d] text-white shadow-sm'
                  : 'text-[#cccccc] hover:text-white hover:bg-[#333333]'
              }`}
            >
              {section.label}
            </button>

            {/* Dropdown Menu */}
            {isOpen && (
              <div
                role="menu"
                className="absolute top-full left-0 mt-1 min-w-[170px] bg-[#252526] border border-[#3e3e3e] rounded-[3px] shadow-2xl py-1 z-50 text-xs text-[#cccccc]"
                style={{
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.4)',
                }}
              >
                {section.items.length === 0 ? (
                  <div className="px-3.5 py-2 text-xs text-[#777777] italic select-none">
                    (Empty)
                  </div>
                ) : (
                  section.items.map((item, idx) => {
                    if (item.divider) {
                      return <div key={idx} className="my-1 border-t border-[#333333]" />;
                    }

                    const hasSubmenu = Boolean(item.submenu && item.submenu.length > 0);
                    const isSubmenuOpen = activeSubmenuId === item.id;

                    return (
                      <div
                        key={item.id || idx}
                        className="relative"
                        onMouseEnter={() => {
                          if (hasSubmenu) {
                            setActiveSubmenuId(item.id);
                          } else {
                            setActiveSubmenuId(null);
                          }
                        }}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          aria-haspopup={hasSubmenu ? 'true' : undefined}
                          aria-expanded={hasSubmenu ? isSubmenuOpen : undefined}
                          disabled={item.disabled}
                          onClick={() => handleItemClick(item)}
                          className={`w-full flex items-center justify-between px-3 py-1.5 text-left transition-colors ${
                            item.disabled
                              ? 'text-[#555555] cursor-not-allowed'
                              : isSubmenuOpen
                              ? 'bg-[#04395e] text-white'
                              : item.danger
                              ? 'hover:bg-red-600/20 hover:text-red-300 text-red-400'
                              : 'hover:bg-[#04395e] hover:text-white text-[#cccccc]'
                          }`}
                        >
                          <span className="flex items-center space-x-2">
                            {item.icon && <span className="w-3.5 h-3.5">{item.icon}</span>}
                            <span>{item.label}</span>
                          </span>
                          {hasSubmenu ? (
                            <ChevronRight className="w-3.5 h-3.5 text-[#888888] ml-3" />
                          ) : (
                            item.shortcut && (
                              <span className="ml-4 font-mono text-[11px] text-[#777777]">
                                {item.shortcut}
                              </span>
                            )
                          )}
                        </button>

                        {/* Nested Submenu */}
                        {hasSubmenu && isSubmenuOpen && !item.disabled && (
                          <div
                            role="menu"
                            className="absolute top-0 left-full -ml-1 min-w-[210px] bg-[#252526] border border-[#3e3e3e] rounded-[3px] shadow-2xl py-1 z-50 text-xs text-[#cccccc]"
                            style={{
                              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.4)',
                            }}
                          >
                            {item.submenu!.map((subItem, sIdx) => {
                              if (subItem.divider) {
                                return (
                                  <div key={sIdx} className="my-1 border-t border-[#333333]" />
                                );
                              }

                              return (
                                <button
                                  key={subItem.id || sIdx}
                                  type="button"
                                  role="menuitem"
                                  disabled={subItem.disabled}
                                  onClick={() => handleItemClick(subItem)}
                                  className={`w-full flex items-center justify-between px-3 py-1.5 text-left transition-colors ${
                                    subItem.disabled
                                      ? 'text-[#555555] cursor-not-allowed'
                                      : 'hover:bg-[#04395e] hover:text-white text-[#cccccc]'
                                  }`}
                                >
                                  <span className="flex items-center space-x-2">
                                    {subItem.icon && (
                                      <span className="w-3.5 h-3.5">{subItem.icon}</span>
                                    )}
                                    <span>{subItem.label}</span>
                                  </span>
                                  {subItem.shortcut && (
                                    <span className="ml-4 font-mono text-[11px] text-[#777777]">
                                      {subItem.shortcut}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
};

