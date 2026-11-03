/**
 * PostCSS pass making Tailwind's output correct inside a shadow root.
 * - `@property` only registers in the document scope, so inside a shadow root
 *   variables like --tw-border-style have no value and `.border` computes to
 *   no border at all. Declare each initial value as a real low-priority rule.
 * - rem follows the HOST page's root font size; resolve it against the app's
 *   root so an embed always matches the notebook whatever page contains it.
 */
export const APP_ROOT_PX = 14.4;

export function shadowCss() {
  return {
    postcssPlugin: 'nebula-viewer-shadow-css',
    Once(root, {AtRule, Rule, Declaration}) {
      const initial = new Map();
      root.walkAtRules('property', rule => {
        rule.walkDecls('initial-value', decl => { initial.set(rule.params.trim(), decl.value); });
      });
      root.walkDecls(decl => {
        decl.value = decl.value.replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${+(Number(n) * APP_ROOT_PX).toFixed(4)}px`);
      });
      const fallback = new Rule({selector: ':host,*,::before,::after,::backdrop'});
      for (const [prop, value] of initial) fallback.append(new Declaration({prop, value}));
      const layer = new AtRule({name: 'layer', params: 'properties'});
      layer.append(fallback);
      root.append(layer);
    },
  };
}
