const core = require('@actions/core')
const filesize = require('filesize')
const fs = require('fs')
const github = require('@actions/github')
const https = require('follow-redirects').https;
const pathname = require('path')
const url = require('url')
const yauzl = require("yauzl");
const util = require('node:util');
const stream = require( 'node:stream');
let got = null;
async function DownloadFile(url, headers, savePath) {
	if (got == null){
		let gImport = await import('got');
		got = gImport.got;
	}
    const pipeline = util.promisify(stream.pipeline);
    const options = {
        headers: headers
    };
    await pipeline(
        got.stream(url,options),
        fs.createWriteStream(savePath)
    );
}

async function downloadAction(name, path) {
    const artifactClient = artifact.create()
    const downloadOptions = {
        createArtifactFolder: false
    }
    const downloadResponse = await artifactClient.downloadArtifact(
        name,
        path,
        downloadOptions
    )
    core.setOutput("found_artifact", true)
}

async function main() {
    try {
        const token = core.getInput("github_token", { required: true })
        const [owner, repo] = core.getInput("repo", { required: true }).split("/")
        const path = core.getInput("path", { required: true })
        const name = core.getInput("name")
        const nameIsRegExp = core.getBooleanInput("name_is_regexp")
        const skipUnpack = core.getBooleanInput("skip_unpack")
        const ifNoArtifactFound = core.getInput("if_no_artifact_found")
        let workflow = core.getInput("workflow")
        let workflowConclusion = core.getInput("workflow_conclusion")
        let pr = core.getInput("pr")
        let commit = core.getInput("commit")
        let branch = core.getInput("branch")
        let event = core.getInput("event")
        let runID = core.getInput("run_id")
        let runNumber = core.getInput("run_number")
        let checkArtifacts = core.getBooleanInput("check_artifacts")
        let searchArtifacts = core.getBooleanInput("search_artifacts")
        const allowForks = core.getBooleanInput("allow_forks")
        let ensureLatest = core.getBooleanInput("ensure_latest")
        let dryRun = core.getInput("dry_run")

        const client = github.getOctokit(token)

        core.info(`==> Repository: ${owner}/${repo}`)
        core.info(`==> Artifact name: ${name}`)
        core.info(`==> Local path: ${path}`)

        if (!workflow) {
            const run = await client.rest.actions.getWorkflowRun({
                owner: owner,
                repo: repo,
                run_id: runID || github.context.runId,
            })
            workflow = run.data.workflow_id
        }

        core.info(`==> Workflow name: ${workflow}`)
        core.info(`==> Workflow conclusion: ${workflowConclusion}`)

        const uniqueInputSets = [
            {
                "pr": pr,
                "commit": commit,
                "branch": branch,
                "run_id": runID
            }
        ]
        uniqueInputSets.forEach((inputSet) => {
            const inputs = Object.values(inputSet)
            const providedInputs = inputs.filter(input => input !== '')
            if (providedInputs.length > 1) {
                throw new Error(`The following inputs cannot be used together: ${Object.keys(inputSet).join(", ")}`)
            }
        })

        if (pr) {
            core.info(`==> PR: ${pr}`)
            const pull = await client.rest.pulls.get({
                owner: owner,
                repo: repo,
                pull_number: pr,
            })
            commit = pull.data.head.sha
            //branch = pull.data.head.ref
        }

        if (commit) {
            core.info(`==> Commit: ${commit}`)
        }

        if (branch) {
            branch = branch.replace(/^refs\/heads\//, "")
            core.info(`==> Branch: ${branch}`)
        }

        if (event) {
            core.info(`==> Event: ${event}`)
        }

        if (runNumber) {
            core.info(`==> Run number: ${runNumber}`)
        }

        core.info(`==> Allow forks: ${allowForks}`)

        if (!runID) {
            // Note that the runs are returned (roughly) in most recent first order. However, for repos
            // with lots and lots of runs, this may not always be the case (hence why we need ensureLatest).
            for await (const runs of client.paginate.iterator(client.rest.actions.listWorkflowRunsForRepo, {
                owner: owner,
                repo: repo,
                workflow_id: workflow,
                ...(branch ? { branch } : {}),
                ...(event ? { event } : {}),
                ...(commit ? { head_sha: commit } : {}),
            }
            )) {
                let runCreatedAt = null;
                for (const run of runs.data) {
                    if (runNumber && run.run_number != runNumber) {
                        continue
                    }
                    if (workflowConclusion && (workflowConclusion != run.conclusion && workflowConclusion != run.status)) {
                        continue
                    }
                    if (!allowForks && run.head_repository.full_name !== `${owner}/${repo}`) {
                        core.info(`==> Skipping run from fork: ${run.head_repository.full_name}`)
                        continue
                    }
                    if (checkArtifacts || searchArtifacts) {
                        let artifacts = await client.paginate(client.rest.actions.listWorkflowRunArtifacts, {
                            owner: owner,
                            repo: repo,
                            run_id: run.id,
                        })
                        if (!artifacts || artifacts.length == 0) {
                            continue
                        }
                        if (searchArtifacts) {
                            const artifact = artifacts.find((artifact) => {
                                if (nameIsRegExp) {
                                    return artifact.name.match(name) !== null
                                }
                                return artifact.name == name
                            })
                            if (!artifact) {
                                continue
                            }
                        }
                    }
                    if (ensureLatest) {
                        if (runCreatedAt === null || ((new Date(run.created_at)) > (new Date(runCreatedAt)))) {
                            runID = run.id;
                            runCreatedAt = run.created_at;
                        }
                        continue;
                    }
                    runID = run.id
                    runCreatedAt = run.created_at;
                    break
                }
                if (runID) {
                    core.info(`==> (found) Run ID: ${runID}`)
                    core.info(`==> (found) Run date: ${runCreatedAt}`)
                    break
                }
            }
        }

        if (!runID) {
            if (workflowConclusion && (workflowConclusion != 'in_progress')) {
                return setExitMessage(ifNoArtifactFound, "no matching workflow run found with any artifacts?")
            }

            try {
                return await downloadAction(name, path)
            } catch (error) {
                return setExitMessage(ifNoArtifactFound, "no matching artifact in this workflow?")
            }
        }

        let artifacts = await client.paginate(client.rest.actions.listWorkflowRunArtifacts, {
            owner: owner,
            repo: repo,
            run_id: runID,
        })

        // One artifact if 'name' input is specified, one or more if `name` is a regular expression, all otherwise.
        if (name) {
            filtered = artifacts.filter((artifact) => {
                if (nameIsRegExp) {
                    return artifact.name.match(name) !== null
                }
                return artifact.name == name
            })
            if (filtered.length == 0) {
                core.info(`==> (not found) Artifact: ${name}`)
                core.info('==> Found the following artifacts instead:')
                for (const artifact of artifacts) {
                    core.info(`\t==> (found) Artifact: ${artifact.name}`)
                }
            }
            artifacts = filtered
        }

        core.setOutput("artifacts", artifacts)

        if (dryRun) {
            if (artifacts.length == 0) {
                core.setOutput("dry_run", false)
                core.setOutput("found_artifact", false)
                return
            } else {
                core.setOutput("dry_run", true)
                core.setOutput("found_artifact", true)
                core.info('==> (found) Artifacts')
                for (const artifact of artifacts) {
                    const size = filesize(artifact.size_in_bytes, { base: 10 })
                    core.info(`\t==> Artifact:`)
                    core.info(`\t==> ID: ${artifact.id}`)
                    core.info(`\t==> Name: ${artifact.name}`)
                    core.info(`\t==> Size: ${size}`)
                }
                return
            }
        }

        if (artifacts.length == 0) {
            return setExitMessage(ifNoArtifactFound, "no artifacts found")
        }

        core.setOutput("found_artifact", true)

        for (const artifact of artifacts) {
            core.info(`==> Artifact: ${artifact.id}`)

            const size = filesize(artifact.size_in_bytes, { base: 10 })

            core.info(`==> Downloading: ${artifact.name}.zip (${size})`)

            let saveTo = `${pathname.join(path, artifact.name)}.zip`
            if (!fs.existsSync(path)) {
                fs.mkdirSync(path, { recursive: true })
            }

            let request = client.rest.actions.downloadArtifact.endpoint({
                owner: owner,
                repo: repo,
                artifact_id: artifact.id,
                archive_format: "zip",
            });


            await DownloadFile(request.url, {...request.headers, Authorization: `token ${token}`}, saveTo);
            core.info("Download Completed");

            if (skipUnpack) {
                continue
            }

            const dir = name ? path : pathname.join(path, artifact.name)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }

            core.startGroup(`==> Extracting: ${artifact.name}.zip`)
            yauzl.open(saveTo, {lazyEntries: true}, function(err, zipfile) {
                if (err) throw err;
                zipfile.readEntry();
                zipfile.on("entry", function(entry) {
                    const filepath = pathname.resolve(pathname.join(dir, entry.fileName))

                    // Make sure the zip is properly crafted.
                    const relative = pathname.relative(dir, filepath);
                    const isInPath = relative && !relative.startsWith('..') && !pathname.isAbsolute(relative);
                    if (!isInPath) {
                        core.info(`    ==> Path ${filepath} resolves outside of ${dir} skipping`)
                        zipfile.readEntry();
                    }

                    // The zip may contain the directory names for newly created files.
                    if (/\/$/.test(entry.fileName)) {
                        // Directory file names end with '/'.
                        // Note that entries for directories themselves are optional.
                        // An entry's fileName implicitly requires its parent directories to exist.
                        if (!fs.existsSync(filepath)) {
                            core.info(`    ==> Creating: ${filepath}`)
                            fs.mkdirSync(filepath, { recursive: true })
                        }
                        zipfile.readEntry();
                    } else {
                        // This is a file entry. Attempt to extract it.
                        core.info(`    ==> Extracting: ${entry.fileName}`)

                        // Ensure the parent folder exists
                        let dirName = pathname.dirname(filepath)
                        if (!fs.existsSync(dirName)) {
                            core.info(`    ==> Creating: ${dirName}`)
                            fs.mkdirSync(dirName, { recursive: true })
                        }
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) throw err;

                            readStream.on("end", () => {
                                zipfile.readEntry();
                            });
                            readStream.on("error", (err) => {
                                throw new Error(`Failed to extract ${entry.fileName}: ${err}`)
                            });

                            const file = fs.createWriteStream(filepath);
                            readStream.pipe(file);
                            file.on("finish", () => {
                                file.close();
                            });
                            file.on("error", (err) => {
                                throw new Error(`Failed to extract ${entry.fileName}: ${err}`)
                            });
                        });
                    }
                });
            });
            core.endGroup()
        }
    } catch (error) {
        core.setOutput("found_artifact", false)
        core.setOutput("error_message", error.message)
        core.setFailed(error.message)
    }

    function setExitMessage(ifNoArtifactFound, message) {
        core.setOutput("found_artifact", false)

        switch (ifNoArtifactFound) {
            case "fail":
                core.setFailed(message)
                break
            case "warn":
                core.warning(message)
                break
            case "ignore":
            default:
                core.info(message)
                break
        }
    }
}

main()
