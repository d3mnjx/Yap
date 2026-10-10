import { refreshSession } from './api.js';
// Retained Blazor documents use the same sole renewal endpoint as chat bootstrap.
// The protected browser timestamp suppresses repeated writes across tabs/resumes.
if (document.documentElement.dataset.appearanceUser) {
    const renew = () => refreshSession().catch(() => {});
    renew();
    setInterval(renew, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) renew();
    });
}
