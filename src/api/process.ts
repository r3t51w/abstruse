import * as docker from './docker';
import { PtyInstance } from './pty';
import * as child_process from 'child_process';
import { generateRandomId } from './utils';
import { getRepositoryByBuildId } from './db/repository';
import { Observable } from 'rxjs';
import { green, red, bold, yellow, blue } from 'chalk';
import { CommandType, Command } from './config';
import { JobProcess } from './process-manager';
const nodePty = require('node-pty');

export interface Job {
  status: 'queued' | 'running' | 'success' | 'failed';
  type: 'setup' | 'build';
  pty: any;
  log: string[];
  exitStatus: number;
}

export interface SpawnedProcessOutput {
  stdout: string;
  stderr: string;
  exit: number;
}

export interface ProcessOutput {
  type: 'data' | 'exit' | 'container' | 'exposedPort';
  data: string;
}

export function startBuildProcess(
  proc: JobProcess,
  image: string,
  variables: string[]
): Observable<ProcessOutput> {
  return new Observable(observer => {
    const name = 'abstruse_' + proc.build_id + '_' + proc.job_id;
    const envs = proc.commands.filter(cmd => cmd.command.startsWith('export'))
      .map(cmd => cmd.command.replace('export', '-e'))
      .reduce((acc, curr) => acc.concat(curr.split(' ')), [])
      .concat(proc.env.reduce((acc, curr) => acc.concat(['-e', curr]), []))
      .concat(variables.reduce((acc, curr) => acc.concat(['-e', curr]), []));

    let debug: Observable<any> = Observable.empty();
    if (proc.sshAndVnc) {
      const ssh = `sudo /etc/init.d/ssh start`;
      const xvfb = [
        'export DISPLAY=:99 &&',
        'sudo /etc/init.d/xvfb start &&',
        'sleep 3 &&',
        'sudo /etc/init.d/openbox start'
      ].join(' ');
      const vnc = [
        'x11vnc -xkb -noxrecord -noxfixes -noxdamage',
        '-display :99 -forever -bg -rfbauth /etc/x11vnc.pass',
        '-rfbport 5900'
      ].join(' ');

      debug = Observable.concat(...[
        executeInContainer(name, { command: ssh, type: CommandType.before_install }),
        getContainerExposedPort(name, 22),
        executeInContainer(name, { command: xvfb, type: CommandType.before_install }),
        executeInContainer(name, { command: vnc, type: CommandType.before_install }),
        getContainerExposedPort(name, 5900)
      ]);
    }

    const sub = startContainer(name, image, envs)
      .concat(debug)
      .concat(...proc.commands.map(cmd => executeInContainer(name, cmd)))
      .subscribe((event: ProcessOutput) => {
        observer.next(event);
      }, err => {
        sub.unsubscribe();
        observer.error(err);
        stopContainer(name).subscribe((event: ProcessOutput) => {
          observer.next(event);
          observer.next({ type: 'data', data: err });
          observer.complete();
        });
      }, () => {
        sub.unsubscribe();
        stopContainer(name).subscribe((event: ProcessOutput) => {
          observer.next(event);
          observer.complete();
        });
      });
  });
}

function executeInContainer(name: string, cmd: Command): Observable<ProcessOutput> {
  return new Observable(observer => {
    let executed = false;
    let attach = null;
    let detachKey = 'D';
    let success = false;

    attach = nodePty.spawn('docker', ['attach', `--detach-keys=${detachKey}`, name]);

    attach.on('data', data => {
      if (!executed) {
        const exec = `/usr/bin/abstruse '${cmd.command}'\r`;
        attach.write(exec);
        observer.next({ type: 'data', data: yellow('==> ' + cmd.command) + '\r' });
        executed = true;
      } else {
        if (data.includes('[success]')) {
          if (cmd.type === CommandType.script) {
            observer.next({ type: 'data', data: green(data.replace(/\n\r/g, '')) });
          }

          success = true;
          attach.write(detachKey);
        } else if (data.includes('[error]')) {
          attach.kill();
          observer.error(red(data.replace(/\n\r/g, '')));
        } else if (!data.includes('/usr/bin/abstruse') &&
          !data.includes('exit $?') && !data.includes('logout') &&
          !data.includes('read escape sequence')) {
          observer.next({ type: 'data', data: data.replace('> ', '') });
        }
      }
    });

    attach.on('exit', code => {
      if (code !== 0 && !success) {
        const msg = [
          yellow('['),
          blue(name),
          yellow(']'),
          ' --- ',
          `Executed command returned exit code ${red(code.toString())}`
        ].join('');
        observer.error(msg);
      } else {
        observer.next({ type: 'exit', data: '0' });
        observer.complete();
      }
    });
  });
}

function startContainer(name: string, image: string, vars = []): Observable<ProcessOutput> {
  return new Observable(observer => {
    docker.killContainer(name)
      .then(() => {
        const args = ['run', '-dit', '--security-opt=seccomp:unconfined', '-P']
          .concat('-m=2048M', '--cpus=2')
          .concat(vars)
          .concat('--name', name, image);

        const process = nodePty.spawn('docker', args);

        process.on('exit', exitCode => {
          if (exitCode !== 0) {
            observer.error(`Error starting container (${exitCode})`);
          } else {
            observer.next({
              type: 'container',
              data: `Container ${bold(name)} succesfully started.`
            });
          }

          observer.complete();
        });
      });
  });
}

export function stopContainer(name: string): Observable<ProcessOutput> {
  return new Observable(observer => {
    const process = nodePty.spawn('docker', [
      'rm',
      '-f',
      name
    ]);

    process.on('exit', exitCode => {
      observer.next({
        type: 'container',
        data: `Container ${bold(name)} succesfully stopped.`
      });

      observer.complete();
    });
  });
}

function getContainerExposedPort(name: string, port: number): Observable<ProcessOutput> {
  return new Observable(observer => {
    const process = nodePty.spawn('docker', [
      'port',
      name,
      port
    ]);

    process.on('data', data => {
      return observer.next({ type: 'exposedPort', data: port + ':' + data.split(':')[1] });
    });
    process.on('exit', () => observer.complete());
  });
}

export function startDockerImageSetupJob(name: string): Job {
  let pty = new PtyInstance();
  let job: Job = {
    status: 'queued',
    type: 'build',
    pty: docker.buildImage(name),
    log: [],
    exitStatus: null
  };

  return job;
}

export function spawn(cmd: string, args: string[]): Promise<SpawnedProcessOutput> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    const command = child_process.spawn(cmd, args);

    command.stdout.on('data', data => stdout += data);
    command.stderr.on('data', data => stderr += data);
    command.on('exit', exit => {
      const output = { stdout, stderr, exit };
      resolve(output);
    });
  });
}

function saveCredentialsToImage(name: string, buildId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    getRepositoryByBuildId(buildId)
      .then(repo => {
        if (repo.username !== '' && repo.password !== '') {
          const matches = repo.clone_url.match(/^https?\:\/\/([^\/?#]+)(?:[\/?#]|$)/i);
          const domain = matches && matches[1];
          const cmd = `echo 'machine ${domain} login ${repo.username} password ${repo.password}'` +
            `> /home/abstruse/.netrc`;
          const save = nodePty.spawn('docker', [
            'exec',
            name,
            'sh',
            '-c',
            cmd
          ]);

          save.on('exit', () => resolve());
        } else {
          resolve();
        }
      });
  });
}
