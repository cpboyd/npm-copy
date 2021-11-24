const path = require('path');
const fs = require('fs');
const RegClient = require('npm-registry-client');
const _ = require('lodash');
const util = require('util');
const npmFetch2 = require('npm-registry-fetch');

// Create Promise functions:
const npm = new RegClient();
const npmPublish = util.promisify((uri, params, cb) =>
  npm.publish(uri, params, (err, data) => cb(err, data))
);

module.exports = async function (argv) {
  const isDryRun = argv['dry-run'];
  if (isDryRun) {
    console.log('dry run: nothing will be published');
  }
  const [to, from] = ['to', 'from'].map((dir) => {
    return {
      url: argv[dir],
      auth: {
        token: argv[`${dir}-token`],
        username: argv[`${dir}-username`],
        password: argv[`${dir}-password`],
        email: argv[`${dir}-email`],
        alwaysAuth: true,
      },
    };
  });

  const moduleNames = argv._;
  if (
    !(
      from.url &&
      (from.auth.token || (from.auth.username && from.auth.password)) &&
      to.url &&
      (to.auth.token || (to.auth.username && to.auth.password)) &&
      moduleNames.length
    )
  ) {
    console.log(
      'usage: npm-copy --from <repository url> --from-token <token> --to <repository url> --to-token <token> moduleA [moduleB...]'
    );
    return;
  }
  if (from.auth.token) {
    console.log('from: using Azure DevOps password');
    from.auth.username = 'VssToken';
    from.auth.password = from.auth.token;
    delete from.auth.token;
  }
  if (to.auth.token) {
    console.log('to: using Azure DevOps password');
    to.auth.username = 'VssToken';
    to.auth.password = to.auth.token;
    delete to.auth.token;
  }

  const fromScope = '//' + from.url.split('//')[1];
  const toScope = '//' + to.url.split('//')[1];
  const scoped = {
    [`${fromScope}:always-auth`]: from.auth.alwaysAuth,
    [`${fromScope}:username`]: from.auth.username,
    [`${fromScope}:_password`]: Buffer.from(
      from.auth.password,
      'utf8'
    ).toString('base64'),
    [`${fromScope}:email`]: from.auth.email || 'email',
    [`${toScope}:always-auth`]: to.auth.alwaysAuth,
    [`${toScope}:username`]: to.auth.username,
    [`${toScope}:_password`]: Buffer.from(to.auth.password, 'utf8').toString(
      'base64'
    ),
    [`${toScope}:email`]: to.auth.email || 'email',
  };

  for (const moduleName of moduleNames) {
    const fromVersions = (
      await npmFetch2.json(`${from.url}/${moduleName}`, scoped)
    ).versions;

    let toVersions;
    try {
      toVersions = (await npmFetch2.json(`${to.url}/${moduleName}`, scoped))
        .versions;
    } catch (error) {
      if (error.code !== 'E404') {
        throw error;
      }
      toVersions = {};
    }

    const versionsToSync = _.difference(
      Object.keys(fromVersions),
      Object.keys(toVersions)
    );

    for (const semver in fromVersions) {
      const { dist, ...oldMetadata } = fromVersions[semver];
      if (versionsToSync.indexOf(semver) < 0) {
        console.log(`${moduleName}@${semver} already exists on destination`);
        continue;
      }

      // clone the metadata skipping private properties and 'dist'
      const newMetadata = {};
      for (const k in oldMetadata) {
        if (k[0] !== '_' && k !== 'dist') {
          newMetadata[k] = oldMetadata[k];
        }
      }

      let remoteTarball;
      if (!isDryRun) {
        remoteTarball = await npmFetch2(dist.tarball, scoped);
      }
      try {
        if (!isDryRun) {
          await npmPublish(`${to.url}`, {
            auth: to.auth,
            metadata: newMetadata,
            // access: 'public',
            body: remoteTarball.body,
          });
        }
        console.log(`${moduleName}@${semver} cloned`);
      } catch (error) {
        remoteTarball.body.end(); // abort
        if (error.code !== 'EPUBLISHCONFLICT') {
          throw error;
        }

        console.warn(
          `${moduleName}@${semver} already exists on the destination, skipping.`
        );
      }
    }
  }
};
