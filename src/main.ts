import * as fs from 'fs'
import {Octokit} from '@octokit/rest'
import {Octokit as CoreOctokit} from '@octokit/core'
import {RestEndpointMethodTypes} from '@octokit/rest'
import * as core from '@actions/core'
import * as github from '@actions/github'
import * as path from 'path'
import * as glob from 'glob'

type RepoAssetsResp =
  RestEndpointMethodTypes['repos']['listReleaseAssets']['response']['data']
type ReleaseByTagResp =
  RestEndpointMethodTypes['repos']['getReleaseByTag']['response']
type CreateReleaseResp =
  RestEndpointMethodTypes['repos']['createRelease']['response']
type UploadAssetResp =
  RestEndpointMethodTypes['repos']['uploadReleaseAsset']['response']

async function get_release_by_tag(
  tag: string,
  prerelease: boolean,
  release_name: string,
  body: string,
  octokit: Octokit
): Promise<ReleaseByTagResp | CreateReleaseResp> {
  try {
    core.debug(`Getting release by tag ${tag}.`)
    return await octokit.repos.getReleaseByTag({
      ...repo(),
      tag: tag
    })
  } catch (error) {
    // If this returns 404, we need to create the release first.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (error.status === 404) {
      core.debug(
        `Release for tag ${tag} doesn't exist yet so we'll create it now.`
      )
      return await octokit.repos.createRelease({
        ...repo(),
        tag_name: tag,
        prerelease: prerelease,
        name: release_name,
        body: body
      })
    } else {
      throw error
    }
  }
}

async function upload_to_release(
  release: ReleaseByTagResp | CreateReleaseResp,
  file: string,
  asset_name: string,
  tag: string,
  overwrite: boolean,
  octokit: Octokit
): Promise<undefined | string> {
  const stat = fs.statSync(file)
  if (!stat.isFile()) {
    core.debug(`Skipping ${file}, since its not a file`)
    return
  }
  const file_size = stat.size
  const file_bytes = fs.readFileSync(file)

  // Check for duplicates.
  const assets: RepoAssetsResp = await octokit.paginate(
    octokit.repos.listReleaseAssets,
    {
      ...repo(),
      release_id: release.data.id
    }
  )
  const duplicate_asset = assets.find(a => a.name === asset_name)
  if (duplicate_asset !== undefined) {
    if (overwrite) {
      core.debug(
        `An asset called ${asset_name} already exists in release ${tag} so we'll overwrite it.`
      )
      await octokit.repos.deleteReleaseAsset({
        ...repo(),
        asset_id: duplicate_asset.id
      })
    } else {
      core.setFailed(`An asset called ${asset_name} already exists.`)
      return duplicate_asset.browser_download_url
    }
  } else {
    core.debug(
      `No pre-existing asset called ${asset_name} found in release ${tag}. All good.`
    )
  }

  core.debug(`Uploading ${file} to ${asset_name} in release ${tag}.`)

  const uploaded_asset: UploadAssetResp =
    await octokit.repos.uploadReleaseAsset(
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      {
        url: release.data.upload_url,
        name: asset_name,
        data: file_bytes as unknown as string,
        headers: {
          'content-type': 'binary/octet-stream',
          'content-length': file_size
        }
      }
    )
  return uploaded_asset.data.browser_download_url
}

function repo(): {owner: string; repo: string} {
  const repo_name = core.getInput('repo_name')
  // If we're not targeting a foreign repository, we can just return immediately and don't have to do extra work.
  if (!repo_name) {
    return github.context.repo
  }
  const owner = repo_name.substring(0, repo_name.indexOf('/'))
  if (!owner) {
    throw new Error(`Could not extract 'owner' from 'repo_name': ${repo_name}.`)
  }
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const repo = repo_name.substring(repo_name.indexOf('/') + 1)
  if (!repo) {
    throw new Error(`Could not extract 'repo' from 'repo_name': ${repo_name}.`)
  }
  return {
    owner,
    repo
  }
}

async function run(): Promise<void> {
  try {
    // Get the inputs from the workflow file: https://github.com/actions/toolkit/tree/master/packages/core#inputsoutputs
    const token = core.getInput('repo_token', {required: true})
    const file = core.getInput('file', {required: true})
    const tag = core
      .getInput('tag', {required: true})
      .replace('refs/tags/', '')
      .replace('refs/heads/', '')

    const file_glob = core.getInput('file_glob') == 'true' ? true : false
    const overwrite = core.getInput('overwrite') == 'true' ? true : false
    const prerelease = core.getInput('prerelease') == 'true' ? true : false
    const release_name = core.getInput('release_name')
    const body = core.getInput('body')

    const octokit: CoreOctokit = github.getOctokit(token)
    const release = await get_release_by_tag(
      tag,
      prerelease,
      release_name,
      body,
      octokit as Octokit
    )

    if (file_glob) {
      const files = glob.sync(file)
      if (files.length > 0) {
        for (const theFile of files) {
          const asset_name = path.basename(theFile)
          const asset_download_url = await upload_to_release(
            release,
            theFile,
            asset_name,
            tag,
            overwrite,
            octokit as Octokit
          )
          core.setOutput('browser_download_url', asset_download_url)
        }
      } else {
        core.setFailed('No files matching the glob pattern found.')
      }
    } else {
      const asset_name =
        core.getInput('asset_name') !== ''
          ? core.getInput('asset_name').replace(/\$tag/g, tag)
          : path.basename(file)
      const asset_download_url = await upload_to_release(
        release,
        file,
        asset_name,
        tag,
        overwrite,
        octokit as Octokit
      )
      core.setOutput('browser_download_url', asset_download_url)
    }
  } catch (error) {
    core.setFailed((error as Error).message)
  }
}

run()
