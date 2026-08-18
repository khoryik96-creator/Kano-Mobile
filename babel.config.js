// Expo Babel config for the React Native app build (Metro). Not used by the Node
// test gate (that is plain tsc). See tsconfig.app.json.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
