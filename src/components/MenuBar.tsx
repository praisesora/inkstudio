import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Check } from 'lucide-react';
import { MenuSection, MenuItem } from '../types/editor';

export const DEFAULT_MENU_SECTIONS: MenuSection[] = [
  { id: 'file', label: 'File', items: [] },
  { id: 'edit', label: 'Edit', items: [] },
  { id: 'animation', label: 'Animation', items: [] },
  { id: 'layer', label: 'Layer', items: [] },
  { id: 'select', label: 'Select', items: [] },
  { id: 'filter', label: 'Filter', items: [] },
  { id: 'view', label: 'View', items: [] },
  { id: 'window', label: 'Window', items: [] },
  { id: 'help', label: 'Help', items: [] },
];

interface MenuBarProps {
  sections?: MenuSection[];
}

interface FloatingPosition {
  top: number;
  left: number;
}

export const MenuBar: React.FC<MenuBarProps> = React.memo(({ sections = DEFAULT_MENU_SECTIONS }) => {
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [activeSubmenuId, setActiveSubmenuId] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [focusedSubIndex, setFocusedSubIndex] = useState<number>(-1);
  const [menuPos, setMenuPos] = useState<FloatingPosition>({ top: 36, left: 8 });
  const [submenuPos, setSubmenuPos] = useState<FloatingPosition>({ top: 36, left: 210 });

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const menuPortalRef = useRef<HTMLDivElement>(null);
  const submenuPortalRef = useRef<HTMLDivElement>(null);
  const submenuTimerRef = useRef<number | null>(null);

  const clearSubmenuTimer = useCallback(() => {
    if (submenuTimerRef.current !== null) {
      window.clearTimeout(submenuTimerRef.current);
      submenuTimerRef.current = null;
    }
  }, []);

  const closeAllMenus = useCallback(() => {
    clearSubmenuTimer();
    setActiveMenuId(null);
    setActiveSubmenuId(null);
    setFocusedIndex(-1);
    setFocusedSubIndex(-1);
  }, [clearSubmenuTimer]);

  const computeMenuPosition = useCallback((menuId: string) => {
    const btn = buttonRefs.current.get(menuId);
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const menuWidth = 220;
    const clampedLeft = Math.max(4, Math.min(rect.left, window.innerWidth - menuWidth - 8));
    setMenuPos({
      top: Math.round(rect.bottom + 4),
      left: Math.round(clampedLeft),
    });
  }, []);

  const computeSubmenuPosition = useCallback((itemId: string, submenuCount: number) => {
    const btn = itemRefs.current.get(itemId);
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const estWidth = 224;
    const estHeight = Math.min(window.innerHeight - 16, submenuCount * 28 + 12);
    const fitsRight = rect.right + 4 + estWidth <= window.innerWidth - 4;
    const left = fitsRight ? rect.right + 2 : Math.max(4, rect.left - estWidth - 2);
    const top = Math.max(8, Math.min(rect.top - 4, window.innerHeight - estHeight - 8));
    setSubmenuPos({
      top: Math.round(top),
      left: Math.round(left),
    });
  }, []);

  const openMenu = useCallback(
    (menuId: string, autoFocusFirst = false) => {
      clearSubmenuTimer();
      computeMenuPosition(menuId);
      setActiveMenuId(menuId);
      setActiveSubmenuId(null);
      setFocusedSubIndex(-1);
      if (autoFocusFirst) {
        const sec = sections.find((s) => s.id === menuId);
        const firstIdx = sec?.items.findIndex((it) => !it.divider && !it.disabled) ?? -1;
        setFocusedIndex(firstIdx);
      } else {
        setFocusedIndex(-1);
      }
    },
    [clearSubmenuTimer, computeMenuPosition, sections]
  );

  const activeSection = activeMenuId ? sections.find((s) => s.id === activeMenuId) ?? null : null;
  const activeSubmenuParent =
    activeSection && activeSubmenuId
      ? activeSection.items.find((it) => it.id === activeSubmenuId && !it.disabled && it.submenu?.length) ?? null
      : null;
  const activeSectionHasCheckables = Boolean(
    activeSection?.items.some((it) => it.checked !== undefined)
  );
  const activeSubmenuHasCheckables = Boolean(
    activeSubmenuParent?.submenu?.some((it) => it.checked !== undefined)
  );

  useEffect(() => {
    return () => clearSubmenuTimer();
  }, [clearSubmenuTimer]);

  useEffect(() => {
    if (!activeMenuId) return;

    const handlePointerDownCapture = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      if (menuPortalRef.current?.contains(target)) return;
      if (submenuPortalRef.current?.contains(target)) return;
      closeAllMenus();
    };

    const handleWindowDismiss = () => {
      closeAllMenus();
    };

    const findNextEnabledIndex = (items: MenuItem[], current: number, delta: 1 | -1): number => {
      if (items.length === 0) return -1;
      let idx = current;
      for (let step = 0; step < items.length; step++) {
        idx = (idx + delta + items.length) % items.length;
        const candidate = items[idx];
        if (candidate && !candidate.divider && !candidate.disabled) {
          return idx;
        }
      }
      return -1;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!activeSection) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (activeSubmenuId) {
          setActiveSubmenuId(null);
          setFocusedSubIndex(-1);
        } else {
          closeAllMenus();
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        if (activeSubmenuParent?.submenu) {
          setFocusedSubIndex((prev) => findNextEnabledIndex(activeSubmenuParent.submenu!, prev, 1));
        } else {
          setFocusedIndex((prev) => findNextEnabledIndex(activeSection.items, prev, 1));
        }
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (activeSubmenuParent?.submenu) {
          setFocusedSubIndex((prev) =>
            findNextEnabledIndex(
              activeSubmenuParent.submenu!,
              prev < 0 ? 0 : prev,
              -1
            )
          );
        } else {
          setFocusedIndex((prev) =>
            findNextEnabledIndex(activeSection.items, prev < 0 ? 0 : prev, -1)
          );
        }
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const focusedItem = focusedIndex >= 0 ? activeSection.items[focusedIndex] : undefined;
        if (!activeSubmenuId && focusedItem && !focusedItem.disabled && focusedItem.submenu?.length) {
          computeSubmenuPosition(focusedItem.id, focusedItem.submenu.length);
          setActiveSubmenuId(focusedItem.id);
          setFocusedSubIndex(findNextEnabledIndex(focusedItem.submenu, -1, 1));
          return;
        }
        const secIdx = sections.findIndex((s) => s.id === activeMenuId);
        if (secIdx >= 0 && sections.length > 1) {
          const nextSec = sections[(secIdx + 1) % sections.length];
          openMenu(nextSec.id, true);
        }
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        if (activeSubmenuId) {
          setActiveSubmenuId(null);
          setFocusedSubIndex(-1);
          return;
        }
        const secIdx = sections.findIndex((s) => s.id === activeMenuId);
        if (secIdx >= 0 && sections.length > 1) {
          const prevSec = sections[(secIdx - 1 + sections.length) % sections.length];
          openMenu(prevSec.id, true);
        }
        return;
      }

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (activeSubmenuParent?.submenu && focusedSubIndex >= 0) {
          const subItem = activeSubmenuParent.submenu[focusedSubIndex];
          if (subItem && !subItem.disabled && !subItem.divider) {
            closeAllMenus();
            subItem.onClick?.();
          }
          return;
        }
        if (focusedIndex >= 0) {
          const item = activeSection.items[focusedIndex];
          if (!item || item.disabled || item.divider) return;
          if (item.submenu?.length) {
            computeSubmenuPosition(item.id, item.submenu.length);
            setActiveSubmenuId(item.id);
            setFocusedSubIndex(findNextEnabledIndex(item.submenu, -1, 1));
          } else {
            closeAllMenus();
            item.onClick?.();
          }
        }
      }
    };

    window.addEventListener('pointerdown', handlePointerDownCapture, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', handleWindowDismiss);
    window.addEventListener('resize', handleWindowDismiss);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDownCapture, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', handleWindowDismiss);
      window.removeEventListener('resize', handleWindowDismiss);
    };
  }, [
    activeMenuId,
    activeSection,
    activeSubmenuId,
    activeSubmenuParent,
    closeAllMenus,
    computeSubmenuPosition,
    focusedIndex,
    focusedSubIndex,
    openMenu,
    sections,
  ]);

  const handleHeaderClick = (menuId: string) => {
    if (activeMenuId === menuId) {
      closeAllMenus();
    } else {
      openMenu(menuId, false);
    }
  };

  const handleHeaderMouseEnter = (menuId: string) => {
    if (activeMenuId !== null && activeMenuId !== menuId) {
      openMenu(menuId, false);
    }
  };

  const handleItemMouseEnter = (item: MenuItem, idx: number) => {
    clearSubmenuTimer();
    if (!item.disabled) {
      setFocusedIndex(idx);
    }
    const hasSub = Boolean(!item.disabled && item.submenu && item.submenu.length > 0);
    if (hasSub) {
      computeSubmenuPosition(item.id, item.submenu!.length);
      setActiveSubmenuId(item.id);
      setFocusedSubIndex(-1);
    } else if (activeSubmenuId !== null) {
      submenuTimerRef.current = window.setTimeout(() => {
        setActiveSubmenuId(null);
        setFocusedSubIndex(-1);
        submenuTimerRef.current = null;
      }, 160);
    }
  };

  const handleItemClick = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.submenu && item.submenu.length > 0) {
      clearSubmenuTimer();
      computeSubmenuPosition(item.id, item.submenu.length);
      setActiveSubmenuId((prev) => (prev === item.id ? null : item.id));
      return;
    }
    closeAllMenus();
    item.onClick?.();
  };

  return (
    <>
      <nav
        ref={containerRef}
        className="flex items-center gap-0.5 relative z-50 shrink-0"
        role="menubar"
        aria-label="Application Menu"
      >
        {sections.map((section) => {
          const isOpen = activeMenuId === section.id;

          return (
            <div key={section.id} className="relative">
              <button
                ref={(el) => {
                  if (el) buttonRefs.current.set(section.id, el);
                  else buttonRefs.current.delete(section.id);
                }}
                type="button"
                role="menuitem"
                aria-haspopup="true"
                aria-expanded={isOpen}
                onClick={() => handleHeaderClick(section.id)}
                onMouseEnter={() => handleHeaderMouseEnter(section.id)}
                className={`h-6 px-2 rounded text-[11px] transition-colors cursor-pointer ${
                  isOpen
                    ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                }`}
              >
                {section.label}
              </button>
            </div>
          );
        })}
      </nav>

      {activeSection &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div
              ref={menuPortalRef}
              role="menu"
              style={{ top: menuPos.top, left: menuPos.left }}
              onMouseEnter={clearSubmenuTimer}
              className="fixed min-w-[216px] max-h-[calc(100vh-44px)] overflow-y-auto bg-[#202020] border border-[#2f2f2f] rounded-md p-1 z-[9998] text-[11px] text-[#e5e5e5] shadow-[0_14px_36px_rgba(0,0,0,0.72)] select-none"
            >
              {activeSection.items.length === 0 ? (
                <div className="px-2.5 py-1.5 text-[#8a8a8a]">Empty</div>
              ) : (
                activeSection.items.map((item, idx) => {
                  if (item.divider) {
                    return <div key={`div-${idx}`} className="my-1 h-px bg-[#2c2c2c]" />;
                  }

                  const hasSubmenu = Boolean(item.submenu && item.submenu.length > 0);
                  const isSubmenuOpen = activeSubmenuId === item.id && !item.disabled;
                  const isFocused = focusedIndex === idx && !item.disabled;
                  const itemKey = item.id || `item-${idx}`;

                  return (
                    <button
                      key={itemKey}
                      ref={(el) => {
                        if (el && item.id) itemRefs.current.set(item.id, el);
                        else if (item.id) itemRefs.current.delete(item.id);
                      }}
                      type="button"
                      role="menuitem"
                      aria-haspopup={hasSubmenu ? 'true' : undefined}
                      aria-expanded={hasSubmenu ? isSubmenuOpen : undefined}
                      disabled={item.disabled}
                      onMouseEnter={() => handleItemMouseEnter(item, idx)}
                      onClick={() => handleItemClick(item)}
                      className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-left transition-colors ${
                        item.disabled
                          ? 'text-[#8a8a8a]/40 cursor-not-allowed'
                          : isSubmenuOpen || isFocused
                          ? item.danger
                            ? 'bg-red-500/15 text-red-300 cursor-pointer'
                            : 'bg-[#2c2c2c] text-[#e5e5e5] cursor-pointer'
                          : item.danger
                          ? 'text-red-400 hover:bg-red-500/15 hover:text-red-300 cursor-pointer'
                          : 'text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {activeSectionHasCheckables && (
                          <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                            {item.checked ? (
                              <Check className="w-3 h-3 text-[var(--accent)]" />
                            ) : null}
                          </span>
                        )}
                        <span className="truncate">{item.label}</span>
                      </span>
                      {hasSubmenu ? (
                        <ChevronRight className="w-3 h-3 text-[#8a8a8a] ml-3 shrink-0" />
                      ) : (
                        item.shortcut && (
                          <span className="ml-4 font-mono text-[10px] text-[#8a8a8a] shrink-0">
                            {item.shortcut}
                          </span>
                        )
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {activeSubmenuParent && activeSubmenuParent.submenu && (
              <div
                ref={submenuPortalRef}
                role="menu"
                style={{ top: submenuPos.top, left: submenuPos.left }}
                onMouseEnter={clearSubmenuTimer}
                className="fixed min-w-[220px] max-h-[calc(100vh-16px)] overflow-y-auto bg-[#202020] border border-[#2f2f2f] rounded-md p-1 z-[9999] text-[11px] text-[#e5e5e5] shadow-[0_14px_36px_rgba(0,0,0,0.75)] select-none"
              >
                {activeSubmenuParent.submenu.map((subItem, sIdx) => {
                  if (subItem.divider) {
                    return <div key={`subdiv-${sIdx}`} className="my-1 h-px bg-[#2c2c2c]" />;
                  }
                  const isSubFocused = focusedSubIndex === sIdx && !subItem.disabled;
                  return (
                    <button
                      key={subItem.id || `sub-${sIdx}`}
                      type="button"
                      role="menuitem"
                      disabled={subItem.disabled}
                      onMouseEnter={() => {
                        clearSubmenuTimer();
                        if (!subItem.disabled) setFocusedSubIndex(sIdx);
                      }}
                      onClick={() => handleItemClick(subItem)}
                      className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-left transition-colors ${
                        subItem.disabled
                          ? 'text-[#8a8a8a]/40 cursor-not-allowed'
                          : isSubFocused
                          ? subItem.danger
                            ? 'bg-red-500/15 text-red-300 cursor-pointer'
                            : 'bg-[#2c2c2c] text-[#e5e5e5] cursor-pointer'
                          : subItem.danger
                          ? 'text-red-400 hover:bg-red-500/15 hover:text-red-300 cursor-pointer'
                          : 'text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {activeSubmenuHasCheckables && (
                          <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                            {subItem.checked ? (
                              <Check className="w-3 h-3 text-[var(--accent)]" />
                            ) : null}
                          </span>
                        )}
                        <span className="truncate">{subItem.label}</span>
                      </span>
                      {subItem.shortcut && (
                        <span className="ml-4 font-mono text-[10px] text-[#8a8a8a] shrink-0">
                          {subItem.shortcut}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </>,
          document.body
        )}
    </>
  );
});

MenuBar.displayName = 'MenuBar';
