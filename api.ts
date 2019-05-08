import * as pulumi from "@pulumi/pulumi";
import * as aws from '@pulumi/aws';
import * as cloud from '@pulumi/cloud-aws'
import * as moment from 'moment';
import * as Octokit from '@octokit/rest';

const api = new cloud.API('github-repo-freshness');

api.get('/', async (req, res) => {
  res.json({ message: 'hello there!' });
});

api.get('/{repo+}', async (req, res) => {
  console.log('REQUEST', req);

  const octokit = new Octokit({
    auth: 'debb075a67023b294b2c7e30a503aefce60bf1ec',
    previews: ['black-panther-preview']
  })
  
  // const RE = /\*\s+\[(?<name>.+?)\]\((?<link>.+?)\)(?<desc>.+)$/gim;

  const [owner, repo] = req.params.repo.split('/');

  console.log('OWNER/REPO', owner, repo);

  const metrics = (await octokit.repos.retrieveCommunityProfileMetrics({
    owner,
    repo
  })).data;

  console.log(metrics);

  const { updated_at } = metrics;
  const relative = moment(updated_at).fromNow(true);

  return res.status(200).json({
    schemaVersion: 1,
    label: '⏱',
    labelColor: 'blue',
    message: relative,
  });

  // res.setHeader('Content-Type', 'text/html').end(`<pre>${JSON.stringify(metrics, null, 2)}</pre>`);
});

const e = api.publish();

export const endpoint = e.url;