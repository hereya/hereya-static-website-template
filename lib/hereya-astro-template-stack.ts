import * as cdk from 'aws-cdk-lib/core';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';

export class HereyaAstroTemplateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Parameters from hereya
    const projectName = process.env['projectName'] as string;
    const workspace = process.env['workspace'] as string;
    const deployWorkspace = process.env['deployWorkspace'] as string;
    const hereyaToken = process.env['hereyaToken'] as string;
    const hereyaCloudUrl = process.env['hereyaCloudUrl'] || 'https://cloud.hereya.dev';

    // Sanitize: projectName may contain org prefix (e.g. "hereya/myapp" → "hereya-myapp")
    const safeName = projectName.replaceAll('/', '-');

    // ── Upload template directory as S3 asset ──
    // Local bundling copies template files and injects hereya.yaml (no Docker needed)
    const templateAsset = new Asset(this, 'TemplateAsset', {
      path: path.join(__dirname, '..', 'template'),
      bundling: {
        image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:20-slim'),
        local: {
          tryBundle(outputDir: string): boolean {
            const templateDir = path.join(__dirname, '..', 'template');
            copyDirSync(templateDir, outputDir);
            const hereyaYamlPath = path.join(outputDir, 'hereya.yaml');
            const existing = fs.existsSync(hereyaYamlPath) ? fs.readFileSync(hereyaYamlPath, 'utf-8') : '';
            fs.writeFileSync(
              hereyaYamlPath,
              existing.trimEnd() + `\nproject: ${projectName}\nworkspace: ${workspace}\n`,
            );
            return true;
          },
        },
      },
    });

    // ── CodeCommit Repository with initial code ──
    const repo = new codecommit.CfnRepository(this, 'Repo', {
      repositoryName: safeName,
      repositoryDescription: `Astro site for ${projectName}`,
      code: {
        branchName: 'main',
        s3: {
          bucket: templateAsset.s3BucketName,
          key: templateAsset.s3ObjectKey,
        },
      },
    });

    // Higher-level reference for use with CodeBuild source
    const repoRef = codecommit.Repository.fromRepositoryName(this, 'RepoRef', safeName);
    repoRef.node.addDependency(repo);

    // ── IAM User for Git HTTPS credentials ──
    const gitUser = new iam.User(this, 'GitUser', {
      userName: `${safeName}-git-user`,
    });

    gitUser.addToPolicy(new iam.PolicyStatement({
      actions: ['codecommit:GitPull', 'codecommit:GitPush'],
      resources: [
        cdk.Arn.format({ service: 'codecommit', resource: safeName }, this),
      ],
    }));

    // Create HTTPS Git credentials via AwsCustomResource (no native CFN resource exists)
    const gitCredential = new cr.AwsCustomResource(this, 'GitCredential', {
      onCreate: {
        service: 'IAM',
        action: 'createServiceSpecificCredential',
        parameters: {
          UserName: gitUser.userName,
          ServiceName: 'codecommit.amazonaws.com',
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse(
          'ServiceSpecificCredential.ServiceSpecificCredentialId',
        ),
      },
      onDelete: {
        service: 'IAM',
        action: 'deleteServiceSpecificCredential',
        parameters: {
          UserName: gitUser.userName,
          ServiceSpecificCredentialId: new cr.PhysicalResourceIdReference(),
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'iam:CreateServiceSpecificCredential',
            'iam:DeleteServiceSpecificCredential',
          ],
          resources: [gitUser.userArn],
        }),
      ]),
    });
    gitCredential.node.addDependency(gitUser);

    const gitUsername = gitCredential.getResponseField(
      'ServiceSpecificCredential.ServiceUserName',
    );
    const gitPassword = gitCredential.getResponseField(
      'ServiceSpecificCredential.ServicePassword',
    );

    // Store the Git password in Secrets Manager
    const gitPasswordSecret = new secretsmanager.Secret(this, 'GitPasswordSecret', {
      secretName: `${safeName}/git-password`,
      description: `CodeCommit Git password for ${safeName}`,
      secretStringValue: cdk.SecretValue.unsafePlainText(gitPassword),
    });

    // ── Store Hereya token in Secrets Manager ──
    const hereyaTokenSecret = new secretsmanager.Secret(this, 'HereyaTokenSecret', {
      secretName: `${safeName}/hereya-token`,
      description: `Hereya personal token for ${safeName} CI/CD`,
      secretStringValue: cdk.SecretValue.unsafePlainText(hereyaToken),
    });

    // ── CodeBuild Project ──
    const buildProject = new codebuild.Project(this, 'BuildProject', {
      projectName: `${safeName}-build`,
      source: codebuild.Source.codeCommit({ repository: repoRef }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        HEREYA_TOKEN: {
          type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          value: hereyaTokenSecret.secretArn,
        },
        HEREYA_CLOUD_URL: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: hereyaCloudUrl,
        },
        DEPLOY_WORKSPACE: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: deployWorkspace,
        },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
    });

    // Grant CodeBuild permission to read secrets
    hereyaTokenSecret.grantRead(buildProject);
    gitPasswordSecret.grantRead(buildProject);

    // Grant CodeBuild broad permissions for hereya deploy (CDK deployments)
    buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'sts:AssumeRole',
        'cloudformation:*',
        's3:*',
        'iam:PassRole',
        'ssm:GetParameter',
        'ssm:GetParameters',
      ],
      resources: ['*'],
    }));

    // ── EventBridge: trigger CodeBuild on push to main ──
    const rule = new events.Rule(this, 'OnPushToMain', {
      eventPattern: {
        source: ['aws.codecommit'],
        detailType: ['CodeCommit Repository State Change'],
        detail: {
          event: ['referenceCreated', 'referenceUpdated'],
          referenceType: ['branch'],
          referenceName: ['main'],
          repositoryName: [safeName],
        },
      },
    });
    rule.node.addDependency(repo);
    rule.addTarget(new targets.CodeBuildProject(buildProject));

    // ── Outputs ──
    new cdk.CfnOutput(this, 'hereyaGitRemoteUrl', {
      value: `https://git-codecommit.${this.region}.amazonaws.com/v1/repos/${safeName}`,
      description: 'CodeCommit HTTPS clone URL',
    });

    new cdk.CfnOutput(this, 'hereyaGitUsername', {
      value: gitUsername,
      description: 'CodeCommit Git HTTPS username',
    });

    new cdk.CfnOutput(this, 'hereyaGitPassword', {
      value: gitPasswordSecret.secretArn,
      description: 'Secrets Manager ARN for CodeCommit Git password (auto-resolved by Hereya)',
    });
  }
}

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
