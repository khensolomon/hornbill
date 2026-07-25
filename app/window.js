import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import { getPages } from './page/index.js';

// NEW: Export a helper to attach responsive behaviors to the parent window explicitly
export function installLayout(window, splitView) {
    if (window.add_breakpoint) {
        const breakpoint = new Adw.Breakpoint({
            condition: Adw.BreakpointCondition.new_length(
                Adw.BreakpointConditionLengthType.MAX_WIDTH,
                600,
                Adw.LengthUnit.PX
            )
        });

        // When window < 600px, collapse the split view
        breakpoint.add_setter(splitView, 'collapsed', true);
        
        window.add_breakpoint(breakpoint);
    }
}

export function createUI() {
    const splitView = new Adw.NavigationSplitView({
        min_sidebar_width: 190,
        max_sidebar_width: 290,
        sidebar_width_fraction: 0.25,
    });

    // ... [Rest of your existing createUI code remains exactly the same] ...
    // ... [Sidebar creation, ListBox, Navigation Stack, Helpers, etc.] ...

    const sidebarPage = new Adw.NavigationPage({ title: 'Menu', tag: 'sidebar' });
    const sidebarToolbar = new Adw.ToolbarView();
    const sidebarHeader = new Adw.HeaderBar({ show_end_title_buttons: false, show_start_title_buttons: false });

    // --- Search UI Setup ---
    const searchButton = new Gtk.ToggleButton({ icon_name: 'system-search-symbolic', tooltip_text: 'Search' });
    sidebarHeader.pack_start(searchButton);
    
    const searchBar = new Gtk.SearchBar();
    const searchEntry = new Gtk.SearchEntry({ placeholder_text: 'Search settings...', hexpand: true, halign: Gtk.Align.FILL });
    searchBar.set_child(searchEntry);
    searchBar.connect_entry(searchEntry);
    searchBar.bind_property('search_mode_enabled', searchButton, 'active', GObject.BindingFlags.BIDIRECTIONAL);

    sidebarToolbar.add_top_bar(sidebarHeader);
    sidebarToolbar.add_top_bar(searchBar);
    
    const listBox = new Gtk.ListBox({
        css_classes: ['navigation-sidebar'],
        selection_mode: Gtk.SelectionMode.SINGLE,
        activate_on_single_click: true 
    });

    const contentNav = new Adw.NavigationView();
    const contentHolderPage = new Adw.NavigationPage({ title: 'Content Stack', tag: 'content-holder' });
    contentHolderPage.set_child(contentNav);
    splitView.set_content(contentHolderPage);

    // --- HELPERS (Keep your existing helpers) ---
    const findPageDefinition = (id) => {
        const sections = getPages();
        const scanList = (list) => {
            if (!list) return null;
            for (const item of list) {
                if (item.id === id) return item;
                if (item.pages) { const f = scanList(item.pages); if (f) return f; }
                if (item.groups) { for (const g of item.groups) { const f = scanList(g.pages); if (f) return f; } }
            }
            return null;
        };
        for (const section of sections) {
            const found = scanList(section.items);
            if (found) return found;
        }
        return null;
    };

    const pushSubPage = (pageData, widget) => {
        const navPage = new Adw.NavigationPage({ title: pageData.title, tag: pageData.id });
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(widget);
        navPage.set_child(toolbar);
        contentNav.push(navPage);
    };

    contentNav.pushName = (subPageId) => {
        const targetDef = findPageDefinition(subPageId);
        if (targetDef) {
            const subContent = targetDef.ui ? targetDef.ui(contentNav) : new Adw.StatusPage({ title: 'No UI' });
            pushSubPage(targetDef, subContent);
        }
    };

    // --- CUSTOM ROW FACTORY (Keep existing) ---
    const createSmartRow = (pageData, { isSearchResult = false, breadcrumb = null } = {}) => {
        const row = new Gtk.ListBoxRow({ activatable: true, selectable: true });
        const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, margin_start: 12, margin_end: 12, margin_top: 8, margin_bottom: 8 });
        row.set_child(box);

        let iconWidget = null;
        if (pageData.icon || isSearchResult) {
            const iconName = pageData.icon || 'system-search-symbolic';
            iconWidget = new Gtk.Image({ icon_name: iconName, pixel_size: 16, valign: Gtk.Align.CENTER, opacity: (!pageData.icon && isSearchResult) ? 0.5 : 1.0 });
            box.append(iconWidget);
        }

        const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true });
        box.append(textBox);
        textBox.append(new Gtk.Label({ label: pageData.title, xalign: 0, css_classes: ['body'], ellipsize: 3 }));
        
        const initialSubtitle = breadcrumb || '';
        textBox.append(new Gtk.Label({ label: initialSubtitle, xalign: 0, css_classes: ['caption', 'dim-label'], visible: !!initialSubtitle }));

        const arrow = new Gtk.Image({ icon_name: 'go-next-symbolic', css_classes: ['dim-label'], icon_size: Gtk.IconSize.NORMAL, valign: Gtk.Align.CENTER });
        box.append(arrow);

        row._pageData = pageData;
        row._arrowWidget = arrow;
        return row;
    };

    // --- RECURSIVE UI GENERATION (Keep existing) ---
    const createAutoMenuUI = (pageData, navigator, subPageId) => {
        const page = new Adw.PreferencesPage();
        const populateGroup = (groupDef, prefGroup) => {
            if (groupDef.pages) {
                groupDef.pages.forEach(subItem => {
                    const row = new Adw.ActionRow({ title: subItem.title, subtitle: subItem.description || '', activatable: true });
                    row.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
                    row.connect('activated', () => {
                        const subContent = subItem.ui ? subItem.ui(navigator) : new Adw.StatusPage({ title: 'No UI' });
                        pushSubPage(subItem, subContent);
                    });
                    prefGroup.add(row);
                });
            }
        };
        if (pageData.pages) {
            const group = new Adw.PreferencesGroup({ title: 'General', description: `Options for ${pageData.title}` });
            populateGroup(pageData, group);
            page.add(group);
        }
        if (pageData.groups) {
            pageData.groups.forEach(grpDef => {
                const group = new Adw.PreferencesGroup({ title: grpDef.title || '', description: grpDef.description || '' });
                populateGroup(grpDef, group);
                page.add(group);
            });
        }
        if (subPageId && navigator.pushName) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                navigator.pushName(subPageId);
                return GLib.SOURCE_REMOVE;
            });
        }
        return page;
    };

    const loadMainPage = (pageData, ...args) => {
        let widget;
        if (pageData.ui) widget = pageData.ui(contentNav, goToPage, ...args);
        else if (pageData.pages || pageData.groups) widget = createAutoMenuUI(pageData, contentNav, ...args);
        else widget = new Adw.StatusPage({ title: 'Under Construction' });

        let navPage = (widget instanceof Adw.NavigationPage) ? widget : null;
        if (!navPage) {
            navPage = new Adw.NavigationPage({ title: pageData.title, tag: pageData.id });
            const toolbar = new Adw.ToolbarView();
            toolbar.add_top_bar(new Adw.HeaderBar());
            toolbar.set_content(widget);
            navPage.set_child(toolbar);
        }
        contentNav.replace([navPage]);
        splitView.set_show_content(true);
    };

    const goToPage = (pageId, ...args) => {
        const targetPage = findPageDefinition(pageId);
        searchBar.set_search_mode(false); 
        if (targetPage) {
            loadMainPage(targetPage, ...args);
            let row = listBox.get_first_child();
            while (row) {
                if (row._pageData && row._pageData.id === pageId) {
                    listBox.select_row(row);
                    break;
                }
                row = row.get_next_sibling();
            }
        }
    };

    // --- SIDEBAR POPULATION ---
    let arrowIcons = [];

    const populateStandardMenu = () => {
        listBox.remove_all(); 
        arrowIcons = [];
        const sections = getPages();

        sections.forEach((section, index) => {
            // A null section title (e.g. the trailing About group) renders as
            // spacing only, mirroring the ungrouped Dashboard at the top.
            if (section.title) {
                const headerLabel = new Gtk.Label({
                    label: section.title,
                    xalign: 0,
                    css_classes: ['heading', 'dim-label'],
                    margin_top: index === 0 ? 12 : 24,
                    margin_bottom: 6,
                    margin_start: 12
                });
                const headerRow = new Gtk.ListBoxRow({ selectable: false, activatable: false, can_focus: false, css_classes: ['header-row'] });
                headerRow.set_child(headerLabel);
                listBox.append(headerRow);
            } else {
                const spacer = new Gtk.ListBoxRow({ selectable: false, activatable: false, can_focus: false, css_classes: ['header-row'] });
                spacer.set_child(new Gtk.Box({ height_request: 18 }));
                listBox.append(spacer);
            }

            if (section.items) {
                section.items.forEach(page => {
                    const row = createSmartRow(page);
                    if (row._arrowWidget) {
                        row._arrowWidget.visible = splitView.collapsed;
                        arrowIcons.push(row._arrowWidget);
                    }
                    row._activateAction = () => loadMainPage(page);
                    listBox.append(row);
                });
            }
        });
    };

    const performSearch = (query) => {
        const sections = getPages();
        const results = [];
        const lowerQuery = query.toLowerCase();

        const checkPage = (page, parentTitle = null, parentId = null) => {
            if (page.searchable === false) return;
            const texts = [page.title, page.description, ...(page.keywords || [])].join(' ').toLowerCase();
            if (texts.includes(lowerQuery)) {
                results.push({ page: page, parentId: parentId || page.id, breadcrumb: parentTitle ? `${parentTitle} > ${page.title}` : null });
            }
            if (page.pages) page.pages.forEach(child => checkPage(child, page.title, page.id));
            if (page.groups) {
                page.groups.forEach(grp => {
                    if (grp.pages) grp.pages.forEach(child => checkPage(child, `${page.title} > ${grp.title}`, page.id));
                });
            }
        };
        sections.forEach(section => { if (section.items) section.items.forEach(item => checkPage(item)); });
        return results;
    };

    const updateSearchResults = () => {
        const query = searchEntry.text;
        if (!query) { populateStandardMenu(); return; }
        listBox.remove_all(); 
        const results = performSearch(query);
        if (results.length === 0) {
            const noRes = new Adw.ActionRow({ title: 'No Results Found', activatable: false });
            listBox.append(noRes);
            return;
        }
        results.forEach(res => {
            const isSubPage = res.page.id !== res.parentId;
            const row = createSmartRow(res.page, { isSearchResult: true, breadcrumb: res.breadcrumb });
            if (row._arrowWidget) row._arrowWidget.visible = true;
            row._activateAction = () => {
                if (isSubPage) goToPage(res.parentId, res.page.id);
                else goToPage(res.page.id);
            };
            listBox.append(row);
        });
    };

    searchEntry.connect('search-changed', () => updateSearchResults());
    listBox.connect('row-activated', (box, row) => {
        if (row && row._activateAction) row._activateAction();
        else if (row && row._pageData) loadMainPage(row._pageData);
    });
    
    const sidebarScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER });
    sidebarScroll.set_child(listBox);
    sidebarToolbar.set_content(sidebarScroll);
    sidebarPage.set_child(sidebarToolbar);
    splitView.set_sidebar(sidebarPage);

    populateStandardMenu();
    const sections = getPages();
    if (sections.length > 0 && sections[0].items && sections[0].items.length > 0) {
        loadMainPage(sections[0].items[0]);
    }

    // REMOVED: splitView.connect('realize', ...); 
    // Reason: We now use installLayout() externally to avoid "realize" issues.

    const updateHeader = () => {
        const isCollapsed = splitView.collapsed;
        sidebarHeader.show_end_title_buttons = isCollapsed;
        sidebarHeader.show_start_title_buttons = isCollapsed;
        arrowIcons.forEach(icon => { try { icon.visible = isCollapsed; } catch(e) {} });
    };
    splitView.connect('notify::collapsed', updateHeader);
    updateHeader();

    return splitView;
}