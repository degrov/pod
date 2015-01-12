var http     = require('http'),
    fs       = require('fs'),
    path     = require('path'),
    spawn    = require('child_process').spawn,
    express  = require('express'),
    pod      = require('../lib/api'),
    app      = express()

// late def, wait until pod is ready
var conf

// middlewares
var reloadConf = function (req, res, next) {
    conf = pod.reloadConfig()
    next()
}

var auth = express.basicAuth(function (user, pass) {
    var u = conf.web.username || 'admin',
        p = conf.web.password || 'admin'
    return user === u && pass === p
})

app.configure(function(){
    app.set('views', __dirname + '/views')
    app.set('view engine', 'ejs')
    app.use(express.favicon())
    app.use(reloadConf)
    app.use(app.router)
    app.use(express.static(path.join(__dirname, 'static')))
});

app.get('/', auth, function (req, res) {
    pod.listApps(function (err, list) {
        if (err) {
            return res.end(err);
        }
        res.render('index', {
            apps: list
        })
    })
});

app.get('/json', auth, function (req, res) {
    pod.listApps(function (err, list) {
        if (err) {
            return res.end(err);
        }
        res.json(list)
    })
});

app.post('/hooks/:appid', express.bodyParser(), function (req, res) {
    var appid = req.params.appid,
        payload = req.body.payload,
        app = conf.apps[appid];

    try {
        payload = JSON.parse(payload)
    } catch (e) {
        return res.end(e.toString())
    }

    if (app && verify(req, app, payload)) {
        executeHook(appid, app, payload, function () {
            res.end()
        })
    } else {
        res.end()
    }
});

// listen when API is ready
pod.once('ready', function () {
    // load config first
    conf = pod.getConfig();

    // conditional open up jsonp based on config
    if (conf.web.jsonp === true) {
        app.get('/jsonp', function (req, res) {
            pod.listApps(function (err, list) {
                if (err) {
                    return res.end(err);
                }
                res.jsonp(list);
            })
        })
    }
    app.listen(process.env.PORT || 9999);
});

// Helpers
function verify (req, app, payload) {
    // not even a remote app
    if (!app.remote) {
        return;
    }

    //Check app.remote if it is from bitbucket or github
    if(app.remote.indexOf('bitbucket') > -1) {
        return verifyBitbucket(req, app, payload);
    } else if(app.remote.indexOf('github') > -1) {
        return verifyGithub(req, app, payload);
    } else {
        console.error(" Unknown repo type, create your own handler! ".red);
    }

}

function verifyBitbucket(req, app, payload) {
// check repo match
    var repo = payload.repository;
    console.log('\n received webhook request from: ', repo);

    if (app.remote.indexOf(repo.slug) <= -1) {
        console.log('Repo slug not matched Aborting '.red, repo.slug, app.remote);
        return false;
    }

    // check branch match
    var commits = payload.commits;

    if(!commits) {
        return false;
    }

    for(var i in commits) {
        var commit = commits[i];
        // check whether this commit is on expected branc;
        // skip it with [pod skip] message
        console.log('commit message: ' + commit.message);

        //If app mode is selective, build only if asked i.e. don't build on all commits
        if(app.mode === 'selective' && !/\[pod build\]/.test(commit.message)) {
            console.log('selective mode and NO [pod build] message, skip this commit.'.yellow);
            continue;
        }

        if (/\[pod skip\]/.test(commit.message)) {
            console.log('[pod skip]ed aborted.'.yellow);
            continue;
        }

        console.log(" Current commit ", commit);
        var branch = commit.branch.replace('refs/heads/', ''),
            expected = app.branch || 'master';

        console.log('expected branch: ' + expected + ', got branch: ' + branch)

        if ((branch === expected) || (commit.author === app.author)) {
            console.log('matched branch or author');
            return true;
        } else {
            console.log("Unmatched branch or author ");
        }

    }

    return false;
}

function verifyGithub(req, app, payload) {

    // check repo match
    var repo = payload.repository;
    console.log('\nreceived webhook request from: ' + repo.url)
    if (strip(repo.url) !== strip(app.remote)) {
        console.log('aborted.');
        return;
    }

    // skip it with [pod skip] message
    var commit = payload.head_commit;
    console.log('commit message: ' + commit.message);
    if (/\[pod skip\]/.test(commit.message)) {
        console.log('aborted.');
        return
    }

    // check branch match
    var branch = payload.ref.replace('refs/heads/', ''),
        expected = app.branch || 'master';

    console.log('expected branch: ' + expected + ', got branch: ' + branch);
    if (branch !== expected) {
        console.log('aborted.');
        return
    }

    return true;
}


function executeHook (appid, app, payload, cb) {
    fs.readFile(path.resolve(__dirname, '../hooks/post-receive'), 'utf-8', function (err, template) {
        if (err) return cb(err);
        var hookPath = conf.root + '/temphook.sh',
            hook = template
                .replace(/\{\{pod_dir\}\}/g, conf.root)
                .replace(/\{\{app\}\}/g, appid);
        if (app.branch) {
            hook = hook.replace('origin/master', 'origin/' + app.branch)
        }
        fs.writeFile(hookPath, hook, function (err) {
            if (err) return cb(err);
            fs.chmod(hookPath, '0777', function (err) {
                if (err) return cb(err);
                console.log('excuting github webhook for ' + appid + '...');
                var child = spawn('bash', [hookPath]);
                child.stdout.pipe(process.stdout);
                child.stderr.pipe(process.stderr);
                child.on('exit', function (code) {
                    fs.unlink(hookPath, cb);
                })
            })
        })
    })
}

function strip (url) {
    return url.replace(/^(https?:\/\/|git@)github\.com(\/|:)|\.git$/g, '')
}