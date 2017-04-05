#include "gl_widget.h"

GLWidget::GLWidget(QWidget *parent) :
  QGLWidget(parent)
{
}

void GLWidget::initializeGL() {
  glClearColor(1, 1, 0, 1);
}

void GLWidget::paintGL() {
  glClear(GL_COLOR_BUFFER_BIT);

  glBegin(GL_TRIANGLES);
    glColor3f(1, 0, 0);
    glVertex3f(-0.5, -0.5, 0);
    glColor3f(0, 1, 0);
    glVertex3f(0.5, -0.5, 0);
    glColor3f(0, 0, 1);
    glVertex3f(0.0, 0.5, 0);
  glEnd();
}

void GLWidget::resizeGL(int w, int h) {
  glViewport(0, 0, w, h);
}
