/*
 * Copyright (c) 2016, Two Sigma Open Source
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of git-meta nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
"use strict";
const co = require("co");
const colors = require("colors/safe");
const NodeGit = require("nodegit");

const GitUtil = require("../util/gitutil");
const SubmoduleUtil = require("../util/submoduleutil");

/**
 * @enum {STAGESTATUS}
 * indicates the meaning of an entry in the index
 */

// From libgit2 index.h.  This information is not documented in
// the nodegit or libgit2 documentation.
const STAGE = {
    NORMAL: 0,  // normally staged file
    OURS  : 2,  // our side of a stage
    THEIRS: 3,  // their side of a stage
};
exports.STAGE = STAGE;

/**
 * Return the `STAGE` for the specified `flags`.
 *
 * @param {Number} flags
 * @return {STAGE}
 */
function getStage(flags) {
    const GIT_IDXENTRY_STAGESHIFT = 12;
    return flags >> GIT_IDXENTRY_STAGESHIFT;
}

exports.getStage = getStage;

/**
 * @enum {FILESTATUS}
 * indicates how a file was changed
 */
const FILESTATUS = {
    MODIFIED: 0,
    ADDED: 1,
    REMOVED: 2,
    CONFLICTED: 3,
    RENAMED: 4,
    TYPECHANGED: 5
};

exports.FILESTATUS = FILESTATUS;

/**
 * @class {RepoStatus} value-semantic type representing the state of a repo
 * TODO: Include submodules status in this object instead of pulling it out
 * later.
 */
class RepoStatus {

    constructor() {
        this.d_currentBranchName = null;
        this.d_headCommit = null;
        this.d_staged = {};
        this.d_workDir = {};
        this.d_untracked = [];
    }

    // MANIPULATORS

    /**
     * Add the specified `fileName` to the list of staged files.
     *
     * @param {String} fileName
     * @param {FILESTATUS} status
     */
    addStaged(fileName, status) {
        this.d_staged[fileName] = status;
    }

    /**
     * Add the specified `fileName` to the list of modified files.
     *
     * @param {String} fileName
     * @param {FILESTATUS} status
     */
    addWorkDir(fileName, status) {
        this.d_workDir[fileName] = status;
    }

    /**
     * Add the specified `fileName` to the list of untracked files.
     *
     * @param {String} fileName
     */
    addUntracked(fileName) {
        this.d_untracked.push(fileName);
    }

    // ACCESSORS

    /**
     * Return true if there are no staged or modified files in this repository.
     * Note that untracked files do not count as modifications.
     *
     * @return {Boolean}
     */
    isClean() {
        return 0 === Object.keys(this.d_staged).length &&
            0 === Object.keys(this.d_workDir).length;
    }

    // PROPERTIES

    /**
     * @property {String} [currentBranchName] name of current branch or null
     *                                        if no current branch
     */
    get currentBranchName() {
        return this.d_currentBranchName;
    }

    set currentBranchName(currentBranchName) {
        this.d_currentBranchName = currentBranchName;
    }

    /**
     * @property {String} [headCommit] sha of head commit or null if no
     * commit
     */
    get headCommit() {
        return this.d_headCommit;
    }
    set headCommit(headCommit) {
        this.d_headCommit = headCommit;
    }

    /**
     * @property {Object} staged map from name to FILESTATUS
     */
    get staged() {
        return this.d_staged;
    }

    /**
     * @property {Object} workDir files modified in working directory
     *                            a map from name to FILESTATUS
     */
    get workDir() {
        return this.d_workDir;
    }

    /**
     * @property {String []} untracked untracked files
     */
    get untracked() {
        return this.d_untracked;
    }
}

exports.RepoStatus = RepoStatus;

/**
 * Return a string describing the file changes in the specified `repoStatus` or
 * an empty string if there are no changes.
 *
 * @param {RepoStatus} repoStatus
 * @return {String}
 */
exports.printFileStatuses = function (repoStatus) {
    let result = "";
    function statusDescription(status) {
        switch(status) {
            case FILESTATUS.ADDED:
                return "new file:     ";
            case FILESTATUS.MODIFIED:
                return "modified:     ";
            case FILESTATUS.REMOVED:
                return "deleted:      ";
            case FILESTATUS.CONFLICTED:
                return "conflicted:   ";
            case FILESTATUS.RENAMED:
                return "renamed:      ";
            case FILESTATUS.TYPECHANGED:
                return "type changed: ";
        }
    }
    const innerIndent = "        ";

    // Print status of staged files first.

    if (0 !== Object.keys(repoStatus.staged).length) {
        if ("" !== result) {
            result += "\n";
        }
        result += "Changes staged to be commited:\n\n";
        Object.keys(repoStatus.staged).sort().forEach(fileName => {
            result += innerIndent;
            const status = repoStatus.staged[fileName];
            result += colors.green(statusDescription(status));
            result += colors.green(fileName);
            result += "\n";
        });
    }

    // Then, print status of files that have been modified but not staged.

    if (0 !== Object.keys(repoStatus.workDir).length) {
        if ("" !== result) {
            result += "\n";
        }
        result += "Changes not staged for commit:\n\n";
        Object.keys(repoStatus.workDir).sort().forEach(fileName => {
            result += innerIndent;
            const status = repoStatus.workDir[fileName];
            result += colors.red(statusDescription(status));
            result += colors.red(fileName);
            result += "\n";
        });
    }

    // Finally, print the names of newly added files.

    if (0 !== repoStatus.untracked.length) {
        if ("" !== result) {
            result += "\n";
        }
        result += "Untracked files:\n\n";
        repoStatus.untracked.forEach(fileName => {
            result += innerIndent;
            result += colors.red(fileName);
            result += "\n";
        });
    }
    return result;
};

/**
 * Return the `FILESTATUS` enumerationi mapped from the specified `status`
 * object.
 *
 * @private
 * @param {NodeGit.StatusFile} status
 * @return {FILESTATUS}
 */
function translateStatus(status) {
    if (status.isNew()) {
        return FILESTATUS.ADDED;
    }
    if (status.isDeleted()) {
        return FILESTATUS.REMOVED;
    }
    if (status.isConflicted()) {
        return FILESTATUS.CONFLICTED;
    }
    if (status.isRenamed()) {
        return FILESTATUS.RENAMED;
    }
    if (status.isTypechange()) {
        return FILESTATUS.TYPECHANGED;
    }
    return FILESTATUS.MODIFIED;
}

/**
 * Return a description of the speccified `repo`.  If the specified
 * `filterPath` function is provided, ignore any paths for which `filterPath`
 * returns false.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Function} [filterPath]
 * @param {String} filterPath.path
 * @param {Boolean} filterPath.return
 * @return {RepoStatus}
 */
const getRepoStatus = co.wrap(function *(repo, filterPath) {
    // TODO: show renamed from and to instead of just to.

    let result = new RepoStatus();

    // Loop through each of the `NodeGit.FileStatus` objects in the repo and
    // categorize them into `result`.

    const statuses = yield repo.getStatusExt({
        flags: NodeGit.Status.OPT.EXCLUDE_SUBMODULES |
            NodeGit.Status.OPT.INCLUDE_UNTRACKED
    });
    for (let i = 0; i < statuses.length; ++i) {
        let status = statuses[i];
        let path = status.path();
        if (filterPath && !filterPath(path)) {
            continue;                                               // CONTINUE
        }
        const fileStatus = translateStatus(status);

        // If the file is `inIndex` that means it's been staged.

        if (status.inIndex()) {
            result.addStaged(path, fileStatus);
        }

        // If it's in the working tree, that means an unstaged change.

        if (status.inWorkingTree()) {

            // If the file is new and in the working tree, that usually means
            // that it's "untracked"; however, if the file has also been staged
            // to the index, we want to show it as modified (vs. index).

            if (status.isNew() && !status.inIndex()) {
                result.addUntracked(path);
            }
            else {
                result.addWorkDir(path, fileStatus);
            }
        }
    }

    // Now, categorize the current branch and head commit status.  If the head
    // is detached, we don't have a current branch.

    result.currentBranchName = yield GitUtil.getCurrentBranchName(repo);
    const commit = yield repo.getHeadCommit();
    result.headCommit = commit.id().tostrS();
    return result;
});

exports.getRepoStatus = getRepoStatus;

/**
 * Return a string describing the specified submodule `status`, displaying a
 * warning if `status` does not have the specified `expectedBranchName` or
 * `expectedSha` or an empty string if there is nothing to report.  If the
 * head commit of the submodule is not on the expected sha, use the specified
 * 'isDescendent' to determine whether or not the submodule is pointing to a
 * descendent of the expected commit.
 *
 * @private
 * @param {String}     expectedBranchName
 * @param {String}     expectedSha
 * @param {RepoStatus} status
 * @param {Boolean}    isDescendent
 * @return {String}
 */
function printSubmoduleStatus(expectedBranchName,
                              expectedSha,
                              status,
                              isDescendent) {
    let result = "";
    if (status.headCommit !== expectedSha) {
        // TODO: print something more descriptive, e.g., whether the sub-repo
        // is:
        //     - ahead expected commit
        //     - behind expected commit
        //     - newly included
        //     - newly removed

        if (!isDescendent) {
            result += `Head is on \
${colors.magenta(GitUtil.shortSha(status.headCommit))}, which is not a \
descendent of the expected commit: \
${colors.magenta(GitUtil.shortSha(expectedSha))}.\n`;
        }
        else {
            result += `Has ${colors.green("new")} commits.\n`;
        }
    }
    if (status.currentBranchName !== expectedBranchName) {
        result += colors.magenta("On wrong branch: '" +
                                 status.currentBranchName + "'.\n");
    }
    result += exports.printFileStatuses(status);
    return result;
}

/**
 * Return the `RepoStatus` for the specified submodule 'repo'.  Additionally,
 * if the head commit of the submodule is not on the specified `expectedHead`,
 * return in `isDescendent` a boolean indicating whether or not the head of the
 * submodule is a descendent of the expected commit, i.e., does the submodule
 * contain new commits or is it pointing to a different history.
 *
 * @async
 * @private
 * @param {NodeGit.Repository} repo
 * @param {String}             expectedHead
 * @return {Object}
 * @return {RepoStatus} return.status
 * @return {Boolean}    [return.isDescendent]
 */
const getSubmoduleStatus = co.wrap(function *(repo, expectedHead) {
    let result = {
        status:  yield exports.getRepoStatus(repo)
    };
    if (result.status.headCommit !== expectedHead) {
        const headCommit = NodeGit.Oid.fromString(result.status.headCommit);
        const expectedCommit = NodeGit.Oid.fromString(expectedHead);
        result.isDescendent = yield NodeGit.Graph.descendantOf(repo,
                                                               headCommit,
                                                               expectedCommit);
    }
    return result;
});

/**
 * Print the status of the submodules in the specified `submoduleNames` in the
 * specified `metaRepo`.
 *
 * @async
 * @param {Stream}             out
 * @param {NodeGit.Repository} metaRepo
 * @param {String[]}           submoduleNames
 */
exports.printSubmodulesStatus =
    co.wrap(function *(out, metaRepo, requestedNames) {

    // TODO: deal with detached head in meta

    const branch = yield metaRepo.getCurrentBranch();
    const branchName = branch.shorthand();
    const headCommit = yield metaRepo.getHeadCommit();
    const expectedShas = yield SubmoduleUtil.getSubmoduleShasForCommit(
                                                                metaRepo,
                                                                requestedNames,
                                                                headCommit);
    // This asynchronous function gets the status for a single repo.

    const getStatus = co.wrap(function *(name) {
        // If the repo is not visible, we can't get any status for it.

        const visible = yield SubmoduleUtil.isVisible(metaRepo, name);
        if (!visible) {
            return null;
        }
        const repo = yield SubmoduleUtil.getRepo(metaRepo, name);
        return yield getSubmoduleStatus(repo, expectedShas[name]);
    });

    // Array of promises for loading sub-repo information.

    const statusGetters = requestedNames.map(getStatus);

    // Load status for sub-repos in parallel.

    const status = yield statusGetters;

    // Now all the status information is loaded, print it out.

    status.forEach((submodule, i) => {
        if (0 !== i) {
            out.write("\n");
        }
        const name = requestedNames[i];
        out.write(colors.cyan(name));
        out.write("\n");
        const repoStatus = submodule.status;
        const isDescendent = submodule.isDescendent;
        if (null === repoStatus) {
            out.write(colors.magenta("not visible\n"));
        }
        else {
            const expectedSha = expectedShas[name];
            const subStatus = printSubmoduleStatus(branchName,
                                                   expectedSha,
                                                   repoStatus,
                                                   isDescendent);
            if ("" === subStatus) {
                out.write("no changes\n");
            }
            else {
                out.write(subStatus);
            }
        }
    });
});

/**
 * Return the `RepositoryStatus` for the specified `metaRepo`, specifically
 * omitting changes to the submodules.
 *
 * @param {NodeGit.Repository} metaRepo
 * @return {RepositoryStatus}
 */
const getMetaStatus = co.wrap(function *(metaRepo) {
    // Collect and print info specific to the meta-repo, first branch and head
    // information, then file changes.

    // Check to see if 'path' is the name of the '.gitmodules' file which
    // is an imp detail of submodules that we want to hide.

    return yield exports.getRepoStatus(metaRepo, path =>
        SubmoduleUtil.modulesFilename !== path
    );
});

/**
 * Print a status description of the specified `metaRepo` to the specified
 * `out` stream.
 *
 * @param {Stream}             out
 * @param {NodeGit.Repository} metaRepo
 */
exports.status = co.wrap(function *(out, metaRepo) {
    // TODO: give a better description of sub-module status, e.g.:
    // - when deleted

    // Collect and print info specific to the meta-repo, first branch and head
    // information, then file changes.

    const metaStatus = yield getMetaStatus(metaRepo);

    if (null !== metaStatus.currentBranchName) {
        out.write("On branch '" + metaStatus.currentBranchName + "'.\n");
    }
    else {
        out.write("On detached head " +
                  GitUtil.shortSha(metaStatus.headCommit));
    }
    const metaStatusDesc = exports.printFileStatuses(metaStatus);
    if ("" === metaStatusDesc) {
        out.write("nothing to commit, working directory clean\n");
    }
    else {
        out.write(metaStatusDesc);
    }

    const head = yield metaRepo.getHeadCommit();
    const subs = yield SubmoduleUtil.getSubmoduleRepos(metaRepo);
    const submoduleNames = subs.map(sub => sub.name);
    const expectedShas = yield SubmoduleUtil.getSubmoduleShasForCommit(
                                                        metaRepo,
                                                        submoduleNames,
                                                        head);

    // Next, load the status information for all the submodules in parallel.

    const subStatusesGetters = subs.map(sub => {
        const expectedSha = expectedShas[sub.name];
        if (undefined !== expectedSha) {
            return getSubmoduleStatus(sub.repo, expectedSha);
        }
        return Promise.resolve(null);
    });
    const subStatuses = yield subStatusesGetters;

    // Then format the sub-repo descriptions.

    let subDescriptionGetters = subStatuses.map(co.wrap(function *(sub, i) {
        const name = subs[i].name;

        // null submodule status indicates that the submodule was just added

        if (null !== sub) {
            const desc = printSubmoduleStatus(metaStatus.currentBranchName,
                                              expectedShas[name],
                                              sub.status,
                                              sub.isDescendent);
            if ("" === desc) {
                return null;
            }
            return colors.cyan(name) + "\n" + desc;
        }
        else {
            // TODO: stop using `lookup` and write own method for getting the
            // url.  `lookup` is very slow.  It probably doesn't matter too
            // much here as the number of times that there will be large
            // numbers of newly added submodules is probably rare.
            const submodule = yield NodeGit.Submodule.lookup(metaRepo, name);
            return `${colors.cyan(name)} was ${colors.green("added")} \
for the url ${colors.blue(submodule.url())}.\n`;
        }
    }));

    let subDescriptions = yield subDescriptionGetters;

    // Filter out any that had no changes.

    subDescriptions = subDescriptions.filter(x => x !== null);

    // And if we have any left, print them a heading and each one.

    if (0 !== subDescriptions.length) {
        out.write("\nSub-repos:\n");
        subDescriptions.forEach(x => {
            out.write("\n");
            out.write(x);
        });
    }
});

/**
 * Do nothing if the specified `metaRepo` and it sub-repositories are clean:
 * having no staged or unstaged changes.  Otherwise, print a diagnostics
 * message and exit the process.
 */
exports.ensureClean = co.wrap(function *(metaRepo) {
    const metaStat = yield getMetaStatus(metaRepo);

    if (!metaStat.isClean()) {
        console.error("The meta-repository is not clean.");
        process.exit(-1);
    }

    const submodules = yield SubmoduleUtil.getSubmoduleRepos(metaRepo);
    const submoduleNames = submodules.map(sub => sub.name);
    const head = yield metaRepo.getHeadCommit();
    const expectedShas = yield SubmoduleUtil.getSubmoduleShasForCommit(
                                                                metaRepo,
                                                                submoduleNames,
                                                                head);
    let allGood = true;
    const checkers = submodules.map(sub => co(function *() {
        const repo = sub.repo;
        const stat = yield getRepoStatus(repo);
        if (expectedShas[sub.name] !== stat.headCommit || !stat.isClean()) {
            console.error(`Sub-repo ${colors.blue(sub.name)} is not \
clean.`);
            allGood = false;
        }
    }));
    yield checkers;
    if (!allGood) {
        process.exit(-1);
    }
});

/**
 * Do nothing if the specified `metaRepo` is in a consistent state; emit one or
 * more errors and terminate the process otherwise.  The `metaRepo` is in a
 * consistent state if:
 *
 * - the meta-repository has a (named) active branch
 * - all submodules that are visible have an active branch with the same name
 *   as the active branch in the meta-repository
 * - the HEAD of each submodule points to a descendant of the commit indicated
 *   in the HEAD of the meta-repo commit.
 *
 * @param async
 * @param {NodeGit.Repository} metaRepo
 */
exports.ensureConsistent = co.wrap(function *(metaRepo) {
    // TODO: check submodule commit status.

    const metaStat = yield getMetaStatus(metaRepo);

    const metaBranch = metaStat.currentBranchName;
    const metaHead   = metaStat.headCommit;

    if (null === metaBranch) {
        console.error("The meta-repository is not on a branch.");
        process.exit(-1);
    }

    if (null === metaHead) {
        console.error("The meta-repository has no head.");
        process.exit(-1);
    }

    if (!metaStat.isClean()) {
        console.error("The meta-repository is not clean.");
        process.exit(-1);
    }
});

/**
 * Do nothing if the specified `metaRepo` is in a clean and consistent state;
 * emit one or more errors and terminate the process otherwise.  The
 * `metaRepo` and its submodules are in a consistent state if both
 * `ensureClean` and `ensureConsistent` succeed.
 *
 * - the meta-repository has a (named) active branch
 * - all submodules that are visible have an active branch with the same name
 *   as the active branch in the meta-repository
 *
 * @param {NodeGit.Repository}
 */
exports.ensureCleanAndConsistent = co.wrap(function *(metaRepo) {
    // TODO: show better info about submodule status, as with the 'status'
    // command TODO.
    // TODO: optimize so that we don't have to request submodules multiple
    // times.

    yield exports.ensureConsistent(metaRepo);
    yield exports.ensureClean(metaRepo);
});
