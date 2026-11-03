// Declare in the game's HTML before WML starts. Replace the example post URL.
window.WML_GAME_UPDATER = {
  protocol: 1,
  postURL: 'https://kone.gg/s/example/aaaaaaaaaaaaaaaaaaaaaa',
  packages: [
    {id: 'full', label: '전체판', file: 'Harbor_v{version}.zip', html: 'Harbor_v{version}.html'},
    {id: 'light', label: '경량판', file: 'Harbor_Light_v{version}.zip', html: 'Harbor_v{version}.html'},
  ],
  preserve: ['custom-data'],
};
