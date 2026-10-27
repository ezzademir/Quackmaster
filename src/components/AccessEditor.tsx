import { FEATURES, GRANTABLE_PAGES, featuresForPages, type FeatureKey, type GrantablePageKey } from '../utils/accessCatalog';

interface AccessEditorProps {
  pages: GrantablePageKey[];
  features: FeatureKey[];
  onChange: (next: { pages: GrantablePageKey[]; features: FeatureKey[] }) => void;
  disabled?: boolean;
}

export function AccessEditor({ pages, features, onChange, disabled }: AccessEditorProps) {
  const selectedPages = new Set(pages);

  function setPages(nextPages: GrantablePageKey[]) {
    onChange({ pages: nextPages, features: featuresForPages(features, nextPages) });
  }

  function togglePage(key: GrantablePageKey) {
    const next = selectedPages.has(key) ? pages.filter((page) => page !== key) : [...pages, key];
    setPages(next);
  }

  function toggleFeature(key: FeatureKey) {
    let next = features.includes(key) ? features.filter((feature) => feature !== key) : [...features, key];
    if (key === 'sales.void' && !next.includes('sales.void')) {
      next = next.filter((feature) => feature !== 'sales.replace');
    }
    onChange({ pages, features: featuresForPages(next, pages) });
  }

  const groups = [...new Set(GRANTABLE_PAGES.map((page) => page.group))];

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const groupPages = GRANTABLE_PAGES.filter((page) => page.group === group);
        return (
          <fieldset key={group} className="space-y-2" disabled={disabled}>
            <legend className="text-xs font-semibold uppercase tracking-wide text-gray-500">{group}</legend>
            {groupPages.map((page) => {
              const pageFeatures = FEATURES.filter((feature) => feature.page === page.key);
              const pageOn = selectedPages.has(page.key);
              return (
                <div key={page.key} className="rounded-lg border border-gray-200 px-3 py-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-900">
                    <input
                      type="checkbox"
                      checked={pageOn}
                      onChange={() => togglePage(page.key)}
                      className="size-4 rounded border-gray-300"
                    />
                    {page.label}
                  </label>
                  {pageFeatures.length > 0 && (
                    <div className="mt-2 space-y-1.5 pl-6">
                      {pageFeatures.map((feature) => (
                        <label
                          key={feature.key}
                          className={`flex items-start gap-2 text-sm ${pageOn ? 'text-gray-700' : 'text-gray-400'}`}
                        >
                          <input
                            type="checkbox"
                            checked={pageOn && features.includes(feature.key)}
                            disabled={!pageOn}
                            onChange={() => toggleFeature(feature.key)}
                            className="mt-0.5 size-4 rounded border-gray-300"
                          />
                          <span>
                            {feature.label}
                            {'hint' in feature && feature.hint ? (
                              <span className="mt-0.5 block text-xs text-gray-500">{feature.hint}</span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
