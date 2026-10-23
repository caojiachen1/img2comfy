// 界面风格（主题）清单与回落工具。id 必须与 src/common/theme.css 的 html[data-theme] 一一对应，
// 数组顺序就是设置页下拉框的顺序 —— 下拉框由这份清单动态生成，免得 HTML 与 CSS 两边对不上。

export const UI_THEMES = [
    { id: 'glass', label: '暗色玻璃（当前）', hint: '半透明面板 + 渐变光晕，就是现在的样子' },
    { id: 'fluent', label: 'Fluent 黑白 · 亮', hint: '纯黑白灰实色，无半透明、无渐变、无毛玻璃、小圆角' },
    { id: 'fluent-dark', label: 'Fluent 黑白 · 暗', hint: '纯黑实色底 + 白字，同样无半透明无渐变' },
    { id: 'neon', label: '霓虹', hint: '深底青紫发光' },
    { id: 'contrast', label: '高对比', hint: '纯黑纯白 + 2px 描边 + 黄色强调，无障碍取向' },
];

export const DEFAULT_UI_THEME = 'glass';

export function normalizeUiTheme(v) {
    return UI_THEMES.some((t) => t.id === v) ? v : DEFAULT_UI_THEME;
}

export function uiThemeLabel(v) {
    const hit = UI_THEMES.find((t) => t.id === v);
    return hit ? hit.label : UI_THEMES[0].label;
}
